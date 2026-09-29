/**
 * Builds the local normalized PO-context corpus from extracted Kaggle CSVs.
 *
 * Default inputs (overridable via CLI flags):
 *   data/datasets/extracted/supply-chain/procurement_orders.csv
 *   data/datasets/extracted/supply-chain/supplier_master.csv
 *   data/datasets/extracted/supply-chain/product_master.csv
 *   data/datasets/extracted/procurement-kpi/Procurement KPI Analysis Dataset.csv
 * Default output: data/datasets/processed/po-context.jsonl
 *
 * Raw archives and processed records stay local (data/datasets/ is ignored).
 * This script never prints dataset rows; it reports counts and file paths only.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { buildPoContext } from "../src/context.ts";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

const defaults = {
  supplyOrders: resolve(root, "data/datasets/extracted/supply-chain/procurement_orders.csv"),
  supplierMaster: resolve(root, "data/datasets/extracted/supply-chain/supplier_master.csv"),
  productMaster: resolve(root, "data/datasets/extracted/supply-chain/product_master.csv"),
  kpi: resolve(root, "data/datasets/extracted/procurement-kpi/Procurement KPI Analysis Dataset.csv"),
  out: resolve(root, "data/datasets/processed/po-context.jsonl"),
};

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

const paths = {
  supplyOrders: resolve(flagValue("supply-orders") ?? defaults.supplyOrders),
  supplierMaster: resolve(flagValue("supplier-master") ?? defaults.supplierMaster),
  productMaster: resolve(flagValue("product-master") ?? defaults.productMaster),
  kpi: resolve(flagValue("kpi") ?? defaults.kpi),
  out: resolve(flagValue("out") ?? defaults.out),
};

async function readRequired(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    console.error(`Missing required input ${label}: ${path}`);
    process.exitCode = 2;
    throw new Error(`Missing required input ${label}`);
  }
}

const [supplyOrdersCsv, supplierMasterCsv, productMasterCsv, kpiCsv] = await Promise.all([
  readRequired(paths.supplyOrders, "supply orders"),
  readRequired(paths.supplierMaster, "supplier master"),
  readRequired(paths.productMaster, "product master"),
  readRequired(paths.kpi, "procurement KPI"),
]);
if (process.exitCode) throw new Error("Missing inputs");

let records;
try {
  records = buildPoContext({ supplyOrdersCsv, supplierMasterCsv, productMasterCsv, kpiCsv });
} catch (error) {
  console.error(`Context build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
  throw error;
}

await mkdir(resolve(paths.out, ".."), { recursive: true });
await writeFile(paths.out, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
const supplyCount = records.filter((record) => record.sourceDataset === "supply-chain").length;
const kpiCount = records.filter((record) => record.sourceDataset === "procurement-kpi").length;
console.log(`Wrote ${records.length} PO context records (${supplyCount} supply-chain, ${kpiCount} procurement-kpi) to ${paths.out}`);
