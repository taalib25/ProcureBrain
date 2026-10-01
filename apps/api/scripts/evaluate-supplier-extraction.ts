import { config as loadDotEnv } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createConfiguredAIProvider } from "../../../packages/ai/src/configured-provider.ts";
import { proposeSupplierCommitment } from "../../../packages/ai/src/adapter.ts";
import { evaluateBySplit, type Prediction } from "../../../packages/ai/src/evaluate.ts";
import type { DatasetGold, DatasetMessage, DatasetSplit } from "../../../packages/ai/src/dataset.ts";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
loadDotEnv({ path: resolve(root, ".env") });
const args = process.argv.slice(2);
const splitArg = args.find(argument => argument.startsWith("--split="))?.slice("--split=".length) ?? "development";
const outputArg = args.find(argument => argument.startsWith("--out="))?.slice("--out=".length);
const allowedSplits: readonly DatasetSplit[] = ["development", "validation", "holdout"];

if (!allowedSplits.includes(splitArg as DatasetSplit)) {
  throw new Error(`Unknown split '${splitArg}'. Choose development, validation, or holdout.`);
}

const split = splitArg as DatasetSplit;
const messageContents = await readFile(resolve(root, "data/generated/supplier_messages.jsonl"), "utf8");
const goldContents = await readFile(resolve(root, "data/gold/expected_extractions.jsonl"), "utf8");
const messages = parseJsonl<DatasetMessage>(messageContents);
const gold = parseJsonl<DatasetGold>(goldContents);
const selectedMessages = messages.filter(row => row.split === split);
const selectedGold = gold.filter(row => row.split === split);
const provider = createConfiguredAIProvider();
const adapter = provider.extractionAdapter;

if (!provider.configured || !adapter) {
  throw new Error(provider.configurationError ?? "No configured text extraction provider is available.");
}

const predictions: Record<string, Prediction> = {};
const reviewStates: Record<string, number> = {};
const usage = { callsWithUsage: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
let adapterFailures = 0;

// Run sequentially so the evaluation stays within provider rate limits and its cost is easy to inspect.
for (const [index, row] of selectedMessages.entries()) {
  const proposal = await proposeSupplierCommitment(
    row.message,
    { sourceRecordId: row.id },
    adapter,
  );
  predictions[row.id] = { commitment: proposal.commitment, state: proposal.state, ...(proposal.reason === "Extraction adapter failed" ? { failure: "extraction_adapter_failed" } : {}) };
  reviewStates[proposal.state] = (reviewStates[proposal.state] ?? 0) + 1;
  if (proposal.reason === "Extraction adapter failed") adapterFailures++;

  const responseUsage = proposal.reason === "Extraction adapter failed" ? null : adapter.lastResponse?.usage;
  if (responseUsage) {
    usage.callsWithUsage++;
    usage.inputTokens += responseUsage.inputTokens ?? 0;
    usage.outputTokens += responseUsage.outputTokens ?? 0;
    usage.totalTokens += responseUsage.totalTokens ?? 0;
  }
  console.error(`[${index + 1}/${selectedMessages.length}] ${row.id}: ${proposal.state}`);
}

const timestamp = new Date().toISOString().replaceAll(":", "-");
const modelSlug = provider.model.replace(/[^a-zA-Z0-9._-]+/g, "_");
const outputPath = resolve(root, outputArg ?? `.tmp/evaluations/${timestamp}-${split}-${modelSlug}.json`);
const metadataPath = `${outputPath}.meta.json`;
const metrics = evaluateBySplit(selectedGold, predictions);
const report = {
  generatedAt: new Date().toISOString(),
  provider: provider.provider,
  model: provider.model,
  promptVersion: process.env.AI_PROMPT_VERSION ?? "supplier-v2",
  schemaVersion: process.env.AI_SCHEMA_VERSION ?? "commitment-v1",
  scorerVersion: "v2-failure-aware",
  datasetSha256: createHash("sha256").update(messageContents).update(goldContents).digest("hex"),
  split,
  examples: selectedMessages.length,
  reviewStates,
  adapterFailures,
  usage,
  metrics,
  limitations: [
    "The supplier-message benchmark is synthetic and scenario-authored, not real supplier traffic.",
    "This run measures this provider/model/prompt/schema snapshot only.",
    "Holdout results should not be used to tune prompts or code; use development and validation for iteration.",
  ],
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(predictions, null, 2)}\n`);
await writeFile(metadataPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ predictions: outputPath, report: metadataPath, ...report }, null, 2));

function parseJsonl<T>(contents: string): T[] {
  return contents.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}
