import { createHash } from "node:crypto";
import type { AnalysisCache, AnalysisRequest, AnalysisRun } from "./types";

function bytes(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? new TextEncoder().encode(input) : input;
}

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(bytes(input)).digest("hex");
}

/** Stable serialization prevents object-key order from producing different cache keys. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

export function analysisCacheKey(request: AnalysisRequest): string {
  const inputHash = sha256(request.input);
  return sha256(stable({
    inputHash,
    mediaType: request.mediaType,
    analysisType: request.analysisType,
    model: request.model,
    provider: request.provider,
    promptVersion: request.promptVersion,
    schemaVersion: request.schemaVersion,
    options: request.options ?? {},
    context: request.context ?? {},
  }));
}

export class MemoryAnalysisCache<TResult = unknown> implements AnalysisCache<TResult> {
  private readonly runs = new Map<string, AnalysisRun<TResult>>();

  constructor(serialized?: string) {
    if (serialized) {
      const runs = JSON.parse(serialized) as AnalysisRun<TResult>[];
      for (const run of runs) this.runs.set(run.cacheKey, run);
    }
  }

  get(cacheKey: string): AnalysisRun<TResult> | undefined { return this.runs.get(cacheKey); }
  set(run: AnalysisRun<TResult>): void { this.runs.set(run.cacheKey, run); }
  delete(cacheKey: string): void { this.runs.delete(cacheKey); }
  values(): readonly AnalysisRun<TResult>[] { return [...this.runs.values()]; }
  export(): string { return JSON.stringify(this.values()); }
}

export function requestMetadata(request: AnalysisRequest): Omit<AnalysisRequest, "input"> {
  const { input: _input, ...metadata } = request;
  return metadata;
}
