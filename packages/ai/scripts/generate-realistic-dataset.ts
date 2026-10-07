import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realisticDataset } from "../src/realistic-dataset.ts";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const { messages, gold } = realisticDataset();
const lines = (values: readonly unknown[]) => `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
await mkdir(resolve(root, "data/generated"), { recursive: true });
await mkdir(resolve(root, "data/gold"), { recursive: true });
await writeFile(resolve(root, "data/generated/realistic_messages.jsonl"), lines(messages));
await writeFile(resolve(root, "data/gold/realistic_extractions.jsonl"), lines(gold));
for (const split of ["tuning", "final"] as const) {
  const selected = messages.filter((row) => row.split === split);
  console.log(`${split}: ${selected.length} messages, scenarios: ${[...new Set(selected.map((row) => row.scenario))].join(", ")}`);
}
console.log(`Wrote ${messages.length} realistic messages plus gold labels. Authored-realistic, not production traffic.`);
