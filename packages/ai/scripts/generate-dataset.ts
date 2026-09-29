import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { generateDataset } from "../src/dataset.ts";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const { messages, gold } = generateDataset(10);
await mkdir(resolve(root, "data/generated"), { recursive: true });
await mkdir(resolve(root, "data/gold"), { recursive: true });
await mkdir(resolve(root, "data/splits"), { recursive: true });
await writeFile(resolve(root, "data/generated/supplier_messages.jsonl"), lines(messages));
await writeFile(resolve(root, "data/gold/expected_extractions.jsonl"), lines(gold));
for (const split of ["development", "validation", "holdout"] as const) {
  const selected = messages.filter(row => row.split === split);
  await writeFile(resolve(root, `data/splits/${split}.json`), `${JSON.stringify({ split, templateFamilies: [...new Set(selected.map(row => row.templateFamily))], ids: selected.map(row => row.id) }, null, 2)}\n`);
}
console.log(`Generated ${messages.length} messages (${messages.filter(row => row.split === "development").length} development, ${messages.filter(row => row.split === "validation").length} validation, ${messages.filter(row => row.split === "holdout").length} holdout).`);

function lines(values: readonly unknown[]) { return `${values.map(value => JSON.stringify(value)).join("\n")}\n`; }
