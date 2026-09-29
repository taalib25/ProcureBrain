import { analysisCacheKey, requestMetadata, sha256 } from "./cache";
import type { AnalysisCache, AnalysisRequest, AnalysisRun, DurableAnalysisCache, ModelAnalysisResult } from "./types";
import { randomUUID } from "node:crypto";

export interface ModelRunner<TResult> {
  run(request: AnalysisRequest): Promise<ModelAnalysisResult<TResult>>;
  /** Optional serializable payloads retained for audit/replay. */
  getLastCall?(): { request?: unknown; response?: unknown; fallbackTier?: string };
}

export interface CachedAnalysis<TResult> {
  readonly run: AnalysisRun<TResult>;
  readonly cacheHit: boolean;
}

/** Executes deterministic preprocessing/model work once per versioned input and replays the stored run thereafter. */
export async function runCachedAnalysis<TResult>(
  request: AnalysisRequest,
  cache: AnalysisCache<TResult>,
  model: ModelRunner<TResult>,
  options: { durable?: DurableAnalysisCache<TResult>; retryFailed?: boolean; leaseMs?: number; pollMs?: number } = {},
): Promise<CachedAnalysis<TResult>> {
  const cacheKey = analysisCacheKey(request);
  let cacheFlights = flights.get(cache);
  if (!cacheFlights) {
    cacheFlights = new Map();
    flights.set(cache, cacheFlights);
  }
  const inFlight = cacheFlights.get(cacheKey);
  if (inFlight) return (await inFlight) as CachedAnalysis<TResult>;
  const operation = perform();
  cacheFlights.set(cacheKey, operation);
  try { return await operation; } finally { cacheFlights.delete(cacheKey); }

  async function perform(): Promise<CachedAnalysis<TResult>> {
  const durable = options.durable;
  let lostClaimRace = false;
  while (true) {
    const existing = durable ? await durable.get(cacheKey) : cache.get(cacheKey);
    if (existing && existing.status !== "failed") {
      if (existing.status !== "running" && existing.status !== "queued") return { run: existing, cacheHit: true };
      if (durable) {
        if (existing.leaseUntil && Date.parse(existing.leaseUntil) > Date.now()) {
          await durable.waitForChange(cacheKey, options.pollMs ?? 100);
          continue;
        }
      } else return { run: existing, cacheHit: true };
    }
    if (existing?.status === "failed" && (!options.retryFailed || lostClaimRace)) return { run: existing, cacheHit: true };

  const id = `analysis_${cacheKey.slice(0, 20)}`;
  const startedAt = new Date().toISOString();
  const base = {
    id,
    cacheKey,
    inputHash: sha256(request.input),
    request: requestMetadata(request),
    createdAt: startedAt,
  } as const;
  const claim = { ...base, status: "running" as const, leaseUntil: new Date(Date.now() + (options.leaseMs ?? 60_000)).toISOString() };
  const ownerToken = randomUUID();
  let generation = 0;
  if (durable) {
    const result = await durable.claim(claim, options.leaseMs ?? 60_000, typeof request.input === "string" ? new TextEncoder().encode(request.input) : request.input, options.retryFailed ?? false, ownerToken);
    if (!result.claimed) {
      if (result.run.status !== "running" && result.run.status !== "queued") return { run: result.run, cacheHit: true };
      lostClaimRace = true;
      await durable.waitForChange(cacheKey, options.pollMs ?? 100);
      continue;
    }
    generation = result.generation ?? result.run.leaseGeneration ?? 0;
  } else cache.set(claim);

  try {
    const heartbeat = durable?.renew ? setInterval(() => { void durable.renew!(cacheKey, ownerToken, generation, options.leaseMs ?? 60_000).catch(() => false); }, Math.max(250, Math.floor((options.leaseMs ?? 60_000) / 3))) : undefined;
    let output: ModelAnalysisResult<TResult>;
    try { output = await model.run(request); } finally { if (heartbeat) clearInterval(heartbeat); }
    const call = model.getLastCall?.();
    const run: AnalysisRun<TResult> = {
      ...base,
      status: output.status ?? "completed",
      result: output.result,
      usage: output.usage,
      modelRequest: output.modelRequest ?? call?.request,
      modelResponse: output.modelResponse ?? call?.response ?? output.result,
      fallbackTier: output.fallbackTier ?? call?.fallbackTier,
      completedAt: new Date().toISOString(),
    };
    if (durable && !await durable.set(run, ownerToken, generation)) {
      const winner = await durable.get(cacheKey);
      if (winner) { cache.set(winner); return { run: winner, cacheHit: true }; }
      throw new Error("Analysis claim was lost and no winning run is available");
    }
    cache.set(run);
    return { run, cacheHit: false };
  } catch (error) {
    const call = model.getLastCall?.();
    const run: AnalysisRun<TResult> = {
      ...base,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      modelRequest: call?.request,
      modelResponse: call?.response,
      fallbackTier: call?.fallbackTier,
      completedAt: new Date().toISOString(),
    };
    if (durable && !await durable.set(run, ownerToken, generation)) {
      const winner = await durable.get(cacheKey);
      if (winner) { cache.set(winner); return { run: winner, cacheHit: true }; }
      throw new Error("Analysis claim was lost and no winning run is available");
    }
    cache.set(run);
    return { run, cacheHit: false };
  }
  }
  }
}

const flights = new WeakMap<object, Map<string, Promise<CachedAnalysis<unknown>>>>();
