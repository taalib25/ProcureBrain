import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => ({}) }));

import { createRuntime, findDotenvPath } from "../src/runtime";

describe("runtime dotenv path discovery", () => {
  it("finds a workspace-root .env above the API working directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "procurebrain-env-"));
    try {
      const apiDirectory = join(workspace, "apps", "api");
      await mkdir(apiDirectory, { recursive: true });
      const envFile = join(workspace, ".env");
      await writeFile(envFile, "", "utf8");
      expect(findDotenvPath(apiDirectory)).toBe(envFile);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("honors DOTENV_CONFIG_PATH relative to the working directory", () => {
    expect(findDotenvPath("/workspace/apps/api", "../local.env")).toBe("/workspace/apps/local.env");
  });
});

describe("PostgreSQL runtime startup", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("applies the base, fencing, tenancy, message, and proposal migrations before constructing the database-mode API", async () => {
    process.env.DATABASE_URL = "postgres://test/db";
    const statements: string[] = [];
    const end = vi.fn(async () => undefined);
    const pool = { query: async (statement: string) => { statements.push(statement); return { rows: [], rowCount: 0 }; }, end } as unknown as Pool;
    const runtime = await createRuntime({ createPool: () => pool, readMigration: async (name) => `-- ${name}` });

    expect(statements.filter(statement => statement.startsWith("--"))).toEqual(["-- 0001_runtime.sql", "-- 0002_analysis_cache_fencing.sql", "-- 0003_organizations_suppliers.sql", "-- 0004_supplier_messages.sql", "-- 0005_change_proposals.sql", "-- 0006_agent_runtime.sql"]);
    expect(await (await runtime.app.request("/api/health")).json()).toEqual({ ok: true, storage: "postgres" });
    await runtime.close();
    expect(end).toHaveBeenCalledOnce();
  });

  it("releases the pool when migration startup fails", async () => {
    process.env.DATABASE_URL = "postgres://test/db";
    const end = vi.fn(async () => undefined);
    const pool = { query: async () => { throw new Error("migration failed"); }, end } as unknown as Pool;

    await expect(createRuntime({ createPool: () => pool, readMigration: async () => "bad migration" })).rejects.toThrow("migration failed");
    expect(end).toHaveBeenCalledOnce();
  });
});
