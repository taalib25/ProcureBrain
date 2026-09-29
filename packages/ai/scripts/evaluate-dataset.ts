import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { evaluateBySplit, type Prediction } from "../src/evaluate.ts";
import type { DatasetGold } from "../src/dataset.ts";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const predictionFile = process.argv.slice(2).find(argument => argument !== "--");
if (!predictionFile) {
  console.error("Usage: pnpm --filter @procurebrain/ai evaluate:dataset -- <predictions.json>");
  console.error("Predictions JSON is an object keyed by example ID; each value is a commitment/null or {expected, reviewState}.");
  process.exitCode = 2;
} else {
  const gold = (await readFile(resolve(root, "data/gold/expected_extractions.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as DatasetGold);
  const predictions = JSON.parse(await readFile(predictionFile, "utf8")) as Record<string, Prediction>;
  console.log(JSON.stringify(evaluateBySplit(gold, predictions), null, 2));
}
