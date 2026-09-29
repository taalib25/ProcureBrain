import { serve } from "@hono/node-server";
import { createRuntime } from "./runtime";

const runtime = await createRuntime();
serve({ fetch: runtime.app.fetch, port: Number(process.env.PORT ?? 8787) });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void runtime.close().finally(() => process.exit(0)); });
