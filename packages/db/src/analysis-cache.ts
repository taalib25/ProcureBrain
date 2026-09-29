import { sql, type SQLWrapper } from "drizzle-orm";
import type { AnalysisRun, DurableAnalysisCache } from "../../analysis-cache/src/types";
import { analysisInputs, analysisRuns } from "./schema";

interface QueryResult { rows?: Record<string, unknown>[]; }
interface DrizzleExecutor { execute(query: SQLWrapper): Promise<unknown>; }

function decode<TResult>(row: Record<string, unknown> | undefined): AnalysisRun<TResult> | undefined {
  if (!row) return undefined;
  const date = (value: unknown) => value instanceof Date ? value.toISOString() : value == null ? undefined : String(value);
  return {
    id: String(row.id), cacheKey: String(row.cache_key), inputHash: String(row.input_hash),
    request: row.request as AnalysisRun<TResult>["request"], status: String(row.status) as AnalysisRun<TResult>["status"],
    result: row.result as TResult | undefined, error: row.error as string | undefined,
    modelRequest: row.model_request, modelResponse: row.model_response,
    usage: row.usage as AnalysisRun<TResult>["usage"], fallbackTier: row.fallback_tier as string | undefined,
    createdAt: date(row.created_at)!, completedAt: date(row.completed_at), leaseUntil: date(row.lease_until),
    leaseGeneration: Number(row.lease_generation ?? 0),
  };
}

async function rows(db: DrizzleExecutor, query: SQLWrapper): Promise<Record<string, unknown>[]> {
  const result = await db.execute(query) as QueryResult | Record<string, unknown>[];
  return Array.isArray(result) ? result : result.rows ?? [];
}

/** PostgreSQL/Drizzle-backed cache. The unique cache key and conditional upsert are the cross-process lock. */
export function createAnalysisCacheRepository(db: DrizzleExecutor): DurableAnalysisCache {
  return {
    async get(cacheKey) {
      const result = await rows(db, sql`select * from analysis_runs where cache_key = ${cacheKey}`);
      return decode(result[0]);
    },
    async claim(run, leaseMs, input, retryFailed, ownerToken) {
      await retainInput(db, run.inputHash, input);
      const lease = new Date(Date.now() + leaseMs);
      const result = await rows(db, sql`insert into analysis_runs
        (cache_key,id,input_hash,request,status,created_at,lease_until,owner_token,lease_generation)
        values (${run.cacheKey},${run.id},${run.inputHash},${JSON.stringify(run.request)}::jsonb,'running',${new Date(run.createdAt)},${lease},${ownerToken},1)
        on conflict (cache_key) do update set id=excluded.id,input_hash=excluded.input_hash,request=excluded.request,status='running',result=null,error=null,model_request=null,model_response=null,usage=null,fallback_tier=null,created_at=excluded.created_at,completed_at=null,lease_until=excluded.lease_until,owner_token=excluded.owner_token,lease_generation=analysis_runs.lease_generation+1
        where (analysis_runs.status='failed' and ${retryFailed}) or (analysis_runs.status in ('running','queued') and analysis_runs.lease_until <= now())
        returning *`);
      if (result[0]) return { run: decode(result[0])!, claimed: true, generation: Number(result[0].lease_generation) };
      return { run: (await this.get(run.cacheKey))!, claimed: false };
    },
    async set(run, ownerToken, generation) {
      const updated = await rows(db, sql`update analysis_runs set status=${run.status},result=${run.result === undefined ? null : JSON.stringify(run.result)}::jsonb,error=${run.error ?? null},model_request=${run.modelRequest === undefined ? null : JSON.stringify(run.modelRequest)}::jsonb,model_response=${run.modelResponse === undefined ? null : JSON.stringify(run.modelResponse)}::jsonb,usage=${run.usage === undefined ? null : JSON.stringify(run.usage)}::jsonb,fallback_tier=${run.fallbackTier ?? null},completed_at=${run.completedAt ? new Date(run.completedAt) : null},lease_until=null,owner_token=null where cache_key=${run.cacheKey} and owner_token=${ownerToken} and lease_generation=${generation} returning cache_key`);
      return updated.length > 0;
    },
    async renew(cacheKey, ownerToken, generation, leaseMs) {
      const updated = await rows(db, sql`update analysis_runs set lease_until=${new Date(Date.now() + leaseMs)} where cache_key=${cacheKey} and owner_token=${ownerToken} and lease_generation=${generation} and status='running' returning cache_key`);
      return updated.length > 0;
    },
    async waitForChange(_cacheKey, pollMs) { await new Promise(resolve => setTimeout(resolve, pollMs)); },
  };
}

/** Insert content once by SHA-256 and keep it addressable for replay. */
export async function retainInput(db: DrizzleExecutor, hash: string, content: Uint8Array): Promise<void> {
  await db.execute(sql`insert into analysis_inputs (hash,content) values (${hash},${content}) on conflict (hash) do nothing`);
}

export async function readRetainedInput(db: DrizzleExecutor, hash: string): Promise<Uint8Array | undefined> {
  const result = await rows(db, sql`select content from analysis_inputs where hash=${hash}`);
  const content = result[0]?.content;
  return content instanceof Uint8Array ? content : undefined;
}

export const analysisCacheTables = { analysisInputs, analysisRuns };
