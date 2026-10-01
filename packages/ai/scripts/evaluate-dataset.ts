import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { evaluateBySplit, type Prediction } from "../src/evaluate.ts";
import type { DatasetGold } from "../src/dataset.ts";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const args = process.argv.slice(2).filter(argument => argument !== "--");
const predictionFile = args.find(argument => !argument.startsWith("--"));
const split = args.find(argument => argument.startsWith("--split="))?.slice("--split=".length);
if (split && !["development", "validation", "holdout"].includes(split)) throw new Error("Choose development, validation, or holdout.");
if (!predictionFile) {
  console.error("Usage: pnpm --filter @procurebrain/ai evaluate:dataset -- <predictions.json>");
  console.error("Predictions JSON is an object keyed by example ID; each value is a commitment/null or {commitment, state}.");
  console.error("Use --split=development|validation|holdout to report only one split.");
  process.exitCode = 2;
} else {
  const gold = (await readFile(resolve(root, "data/gold/expected_extractions.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as DatasetGold);
  const input: unknown = JSON.parse(await readFile(predictionFile, "utf8"));
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Predictions must be an object keyed by example ID.");
  const predictions = input as Record<string, Prediction>;
  const selectedGold = split ? gold.filter(row => row.split === split) : gold;
  console.log(JSON.stringify(evaluateBySplit(selectedGold, predictions), null, 2));
}
