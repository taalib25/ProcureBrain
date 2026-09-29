import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { createAnalysisCacheRepository } from "../src/analysis-cache";
import type { AnalysisRun } from "../../analysis-cache/src/types";

const failedRun: AnalysisRun = {
  id: "analysis-1", cacheKey: "key-1", inputHash: "hash-1", request: { mediaType: "text", analysisType: "extract", model: "m", provider: "p", promptVersion: "1", schemaVersion: "1" },
  status: "failed", createdAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(), error: "previous failure",
};

describe("durable analysis cache repository fencing", () => {
  it("passes retry eligibility to the atomic failed-row claim", async () => {
    const queries: string[] = [];
    const db = { execute: vi.fn(async query => {
      const built = new PgDialect().sqlToQuery(query.getSQL());
      queries.push(built.sql);
      if (built.sql.includes("insert into analysis_runs")) {
        return built.params[7] === true ? { rows: [{
          id: claimRun.id, cache_key: claimRun.cacheKey, input_hash: claimRun.inputHash,
          request: claimRun.request, status: "running", created_at: claimRun.createdAt,
          lease_until: new Date(Date.now() + 1_000), lease_generation: 4, owner_token: "worker-b",
        }] } : { rows: [] };
      }
      if (built.sql.includes("select * from analysis_runs")) return { rows: [{
        id: failedRun.id, cache_key: failedRun.cacheKey, input_hash: failedRun.inputHash,
        request: failedRun.request, status: "failed", created_at: failedRun.createdAt,
        completed_at: failedRun.completedAt, error: failedRun.error, lease_generation: 3,
      }] };
      return { rows: [] };
    }) };
    const repository = createAnalysisCacheRepository(db);
    const claim = { ...failedRun, status: "running" as const, error: undefined };
    const claimRun = claim;
    const rejected = await repository.claim(claim, 1_000, new Uint8Array([1]), false, "worker-a");
    const accepted = await repository.claim(claim, 1_000, new Uint8Array([1]), true, "worker-b");
    expect(rejected.claimed).toBe(false);
    expect(accepted.claimed).toBe(true);
    expect(accepted.generation).toBe(4);
    const claimSql = queries.filter(query => query.includes("insert into analysis_runs"));
    expect(claimSql).toHaveLength(2);
    expect(claimSql[0]).toContain("analysis_runs.status='failed' and $8");
    expect(claimSql[1]).toContain("analysis_runs.status='failed' and $8");
    expect(claimSql[1]).toContain("lease_generation=analysis_runs.lease_generation+1");
  });

  it("conditions renew and completion updates on both owner token and generation", async () => {
    const statements: string[] = [];
    const db = { execute: vi.fn(async query => {
      const built = new PgDialect().sqlToQuery(query.getSQL());
      statements.push(built.sql);
      return { rows: [{ cache_key: "key-1" }] };
    }) };
    const repository = createAnalysisCacheRepository(db);
    const owns = await repository.renew!("key-1", "owner-2", 8, 1_000);
    const saved = await repository.set({ ...failedRun, status: "completed", error: undefined, result: { ok: true } }, "owner-2", 8);
    expect(owns).toBe(true);
    expect(saved).toBe(true);
    expect(statements[0]).toContain("owner_token=$3 and lease_generation=$4");
    expect(statements[1]).toContain("owner_token=$10 and lease_generation=$11 returning cache_key");
  });
});
