import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { createAnalysisCacheRepository } from "../../../packages/db/src/analysis-cache";
import { MemoryStore, PostgresStore } from "./store";
import { createApp } from "./app";
import { createPaddleOcrAdapter } from "./paddleocr";

const dotenvPath = findDotenvPath(process.cwd(), process.env.DOTENV_CONFIG_PATH);
if (dotenvPath) loadDotenv({ path: dotenvPath });

/** Finds an explicit dotenv path or searches cwd and up to four parent directories. */
export function findDotenvPath(cwd: string, override?: string): string | undefined {
  if (override) return resolve(cwd, override);
  let directory = resolve(cwd);
  for (let depth = 0; depth <= 4; depth += 1) {
    const candidate = join(directory, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

interface RuntimeDependencies {
  createPool?: () => Pool;
  readMigration?: (path: string) => Promise<string>;
}

/** No DATABASE_URL means deliberate local/test memory mode; production deployments should set it. */
export async function createRuntime(dependencies: RuntimeDependencies = {}) {
  const ocrAdapter = createPaddleOcrAdapter();
  if (!process.env.DATABASE_URL) return { app: createApp(new MemoryStore(), { storageMode: "memory", ocrAdapter }), close: () => ocrAdapter.close() };
  const pool = dependencies.createPool?.() ?? new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX ?? 10) });
  try {
    const load = dependencies.readMigration ?? (async (name: string) => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    for (const migration of ["0001_runtime.sql", "0002_analysis_cache_fencing.sql"]) await pool.query(await load(migration));
    const db = drizzle(pool);
    const durableCache = createAnalysisCacheRepository(db as never);
    return { app: createApp(new PostgresStore(pool), { durableCache, storageMode: "postgres", ocrAdapter }), close: async () => { await Promise.all([pool.end(), ocrAdapter.close()]); } };
  } catch (error) {
    await Promise.all([pool.end(), ocrAdapter.close()]);
    throw error;
  }
}
