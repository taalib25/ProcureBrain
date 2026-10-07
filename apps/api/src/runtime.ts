import { ConnectorRepository } from "./connectors/repository";
import { ConnectorIngest } from "./connectors/ingest";
import { GmailConnector } from "./connectors/gmail";
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { createAnalysisCacheRepository } from "../../../packages/db/src/analysis-cache";
import { MemoryStore, PostgresStore } from "./store";
import { WorkRepository } from "./agent/repository";
import { PurchasingAgent } from "./agent/runtime";
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
  if (!process.env.DATABASE_URL) {
    const agent = new PurchasingAgent(new WorkRepository(), process.env);
    const store = new MemoryStore();
    const ingest = new ConnectorIngest(store, agent);
    const gmail = new GmailConnector(new ConnectorRepository(), ingest, store, process.env);
    const app = createApp(store, { storageMode: "memory", ocrAdapter, agent, connectors: { gmail, ingest, env: process.env } });
    agent.start(); gmail.start();
    return { app, close: async () => { await gmail.close(); await agent.close(); await ocrAdapter.close(); } };
  }
  const pool = dependencies.createPool?.() ?? new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX ?? 10) });
  try {
    const load = dependencies.readMigration ?? (async (name: string) => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    for (const migration of ["0001_runtime.sql", "0002_analysis_cache_fencing.sql", "0003_organizations_suppliers.sql", "0004_supplier_messages.sql", "0005_change_proposals.sql", "0006_agent_runtime.sql", "0007_connector_state.sql"]) await pool.query(await load(migration));
    const db = drizzle(pool);
    const durableCache = createAnalysisCacheRepository(db as never);
    const agent = new PurchasingAgent(new WorkRepository(pool), process.env);
    const store = new PostgresStore(pool);
    const ingest = new ConnectorIngest(store, agent);
    const gmail = new GmailConnector(new ConnectorRepository(pool), ingest, store, process.env);
    const app = createApp(store, { durableCache, storageMode: "postgres", ocrAdapter, agent, connectors: { gmail, ingest, env: process.env } });
    agent.start(); gmail.start();
    return { app, close: async () => { await gmail.close(); await agent.close(); await Promise.all([pool.end(), ocrAdapter.close()]); } };
  } catch (error) {
    await Promise.all([pool.end(), ocrAdapter.close()]);
    throw error;
  }
}
