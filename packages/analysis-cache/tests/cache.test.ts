import { describe, expect, it, vi } from "vitest";
import { MemoryAnalysisCache } from "../src/cache";
import { runCachedAnalysis } from "../src/runner";
import type { AnalysisRequest } from "../src/types";
import type { AnalysisRun, DurableAnalysisCache } from "../src/types";

const request = (input: string | Uint8Array, overrides: Partial<AnalysisRequest> = {}): AnalysisRequest => ({
  input,
  mediaType: "csv",
  analysisType: "purchase_order_import",
  model: "provider/model-v1",
  provider: "provider",
  promptVersion: "prompt-1",
  schemaVersion: "schema-1",
  ...overrides,
});

describe("analysis cache", () => {
  it("replays identical CSV analysis without a second model call", async () => {
    const cache = new MemoryAnalysisCache<{ rows: number }>();
    const model = { run: vi.fn().mockResolvedValue({ result: { rows: 3 }, usage: { totalTokens: 100 } }) };

    const first = await runCachedAnalysis(request("po,qty\nPO-1,3"), cache, model);
    const second = await runCachedAnalysis(request("po,qty\nPO-1,3"), cache, model);

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(model.run).toHaveBeenCalledTimes(1);
    expect(second.run.usage?.totalTokens).toBe(100);
  });

  it("uses the same boundary for image bytes and invalidates by model version", async () => {
    const cache = new MemoryAnalysisCache<{ label: string }>();
    const model = { run: vi.fn().mockResolvedValue({ result: { label: "invoice" } }) };
    const image = new Uint8Array([137, 80, 78, 71]);

    await runCachedAnalysis(request(image, { mediaType: "image", analysisType: "image_extract" }), cache, model);
    const hit = await runCachedAnalysis(request(image, { mediaType: "image", analysisType: "image_extract" }), cache, model);
    const miss = await runCachedAnalysis(request(image, { mediaType: "image", analysisType: "image_extract", model: "provider/model-v2" }), cache, model);

    expect(hit.cacheHit).toBe(true);
    expect(miss.cacheHit).toBe(false);
    expect(model.run).toHaveBeenCalledTimes(2);
  });

  it("invalidates interpretation options and context", async () => {
    const cache = new MemoryAnalysisCache();
    const model = { run: vi.fn().mockResolvedValue({ result: { ok: true } }) };
    const base = request("same", { options: { locale: "en" }, context: { supplier: "A" } });
    await runCachedAnalysis(base, cache, model);
    expect((await runCachedAnalysis(request("same", { options: { locale: "fr" }, context: { supplier: "A" } }), cache, model)).cacheHit).toBe(false);
    expect((await runCachedAnalysis(request("same", { options: { locale: "en" }, context: { supplier: "B" } }), cache, model)).cacheHit).toBe(false);
    expect(model.run).toHaveBeenCalledTimes(3);
  });

  it("single-flights parallel calls and explicitly retries failed attempts", async () => {
    const cache = new MemoryAnalysisCache();
    let resolve!: (value: { result: { ok: boolean } }) => void;
    const model = { run: vi.fn().mockImplementationOnce(() => new Promise(resolvePromise => { resolve = resolvePromise; })).mockResolvedValue({ result: { ok: true } }) };
    const one = runCachedAnalysis(request("parallel"), cache, model);
    const two = runCachedAnalysis(request("parallel"), cache, model);
    await Promise.resolve();
    await Promise.resolve();
    resolve({ result: { ok: true } });
    const [first, second] = await Promise.all([one, two]);
    expect(model.run).toHaveBeenCalledTimes(1);
    expect(first.run.id).toBe(second.run.id);
    const failing = { run: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ result: { ok: true } }) };
    const failed = await runCachedAnalysis(request("retry"), cache, failing);
    const retried = await runCachedAnalysis(request("retry"), cache, failing, { retryFailed: true });
    expect(failed.run.status).toBe("failed");
    expect(retried.run.status).toBe("completed");
    expect(failing.run).toHaveBeenCalledTimes(2);
  });

  it("returns the fenced winner when an expired worker finishes late", async () => {
    let row: AnalysisRun<{ value: string }> | undefined;
    let currentGeneration = 0;
    let currentOwner = "";
    const durable: DurableAnalysisCache<{ value: string }> = {
      get: async () => row,
      claim: async (run, leaseMs, _input, retryFailed, ownerToken) => {
        if (row && row.status !== "failed" && Date.parse(row.leaseUntil ?? "") > Date.now()) return { run: row, claimed: false };
        if (row?.status === "failed" && !retryFailed) return { run: row, claimed: false };
        currentGeneration += 1;
        currentOwner = ownerToken;
        row = { ...run, leaseUntil: new Date(Date.now() + leaseMs).toISOString(), leaseGeneration: currentGeneration };
        return { run: row, claimed: true, generation: currentGeneration };
      },
      set: async (run, ownerToken, generation) => {
        if (currentOwner !== ownerToken || row?.leaseGeneration !== generation) return false;
        row = { ...run, leaseGeneration: generation };
        return true;
      },
      renew: async () => true,
      waitForChange: async () => undefined,
    };
    let finishOld!: (result: { result: { value: string } }) => void;
    const oldWorker = runCachedAnalysis<{ value: string }>(request("fenced"), new MemoryAnalysisCache<{ value: string }>(), {
      run: () => new Promise(resolve => { finishOld = resolve; }),
    }, { durable });
    await Promise.resolve();
    await Promise.resolve();
    row = { ...row!, leaseUntil: new Date(0).toISOString() };
    const newWorker = await runCachedAnalysis<{ value: string }>(request("fenced"), new MemoryAnalysisCache<{ value: string }>(), {
      run: async () => ({ result: { value: "winner" } }),
    }, { durable });
    finishOld({ result: { value: "stale" } });
    const oldResult = await oldWorker;
    expect(newWorker.run.result?.value).toBe("winner");
    expect(oldResult.run.result?.value).toBe("winner");
  });

  it("does not let a racing non-retry claim reclaim a failed row", async () => {
    let reads = 0;
    let retryEligibility: boolean | undefined;
    const failed: AnalysisRun = { id: "failed", cacheKey: "", inputHash: "", request: { mediaType: "csv", analysisType: "x", model: "m", provider: "p", promptVersion: "1", schemaVersion: "1" }, status: "failed", error: "failed", createdAt: new Date().toISOString() };
    const durable = {
      get: async () => ++reads === 1 ? undefined : failed,
      claim: async (_run: AnalysisRun, _leaseMs: number, _input: Uint8Array, retry: boolean) => { retryEligibility = retry; return { run: failed, claimed: false }; },
      set: async () => false,
      waitForChange: async () => undefined,
    } as unknown as DurableAnalysisCache;
    const model = { run: vi.fn().mockResolvedValue({ result: "should not run" }) };
    const outcome = await runCachedAnalysis(request("racing-failure"), new MemoryAnalysisCache(), model, { durable, retryFailed: false });
    expect(retryEligibility).toBe(false);
    expect(outcome.run.status).toBe("failed");
    expect(model.run).not.toHaveBeenCalled();
  });

  it("persists failed states for inspection and can restore completed runs", async () => {
    const cache = new MemoryAnalysisCache();
    const model = vi.fn().mockRejectedValue(new Error("parse failed"));
    const failed = await runCachedAnalysis(request("bad"), cache, { run: model });
    expect(failed.run.status).toBe("failed");
    expect(failed.run.error).toBe("parse failed");

    const serialized = cache.export();
    const restored = new MemoryAnalysisCache(serialized);
    expect(restored.values()).toHaveLength(1);
    expect(restored.values()[0].status).toBe("failed");
    expect(restored.export()).toBe(serialized);
    const replayed = await runCachedAnalysis(request("bad"), restored, { run: model });
    expect(replayed.cacheHit).toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
  });
});
