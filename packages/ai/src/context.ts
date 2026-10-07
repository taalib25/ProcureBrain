import { z } from "zod";

/**
 * Canonical purchase-order context record.
 *
 * One stable shape covers both structured PO datasets without cross-joining
 * unrelated sources. Supply-chain rows are enriched only with their own
 * supplier/product masters; procurement-KPI rows are mapped standalone.
 * Company-document OCR text is never joined into this shape.
 */
export const PoContextRecordSchema = z.object({
  poId: z.string().trim().min(1),
  sourceDataset: z.enum(["supply-chain", "procurement-kpi", "operational"]),
  supplierId: z.string().trim().min(1).nullable(),
  supplierName: z.string().trim().min(1).nullable(),
  materialId: z.string().trim().min(1).nullable(),
  productName: z.string().trim().min(1).nullable(),
  itemCategory: z.string().trim().min(1).nullable(),
  orderDate: z.string().trim().min(1).nullable(),
  plannedDeliveryDate: z.string().trim().min(1).nullable(),
  actualDeliveryDate: z.string().trim().min(1).nullable(),
  quantity: z.number().finite().nonnegative().nullable(),
  unitCost: z.number().finite().nonnegative().nullable(),
  negotiatedPrice: z.number().finite().nonnegative().nullable(),
  totalCost: z.number().finite().nonnegative().nullable(),
  orderStatus: z.string().trim().min(1).nullable(),
  defectiveUnits: z.number().finite().nonnegative().nullable(),
  compliance: z.string().trim().min(1).nullable(),
  supplierOnTimeRate: z.number().finite().min(0).max(1).nullable(),
  preferredSupplier: z.boolean().nullable(),
  provenance: z.object({
    sourceDataset: z.enum(["supply-chain", "procurement-kpi", "operational"]),
    sourceFile: z.string().trim().min(1),
  }).strict(),
}).strict();

export type PoContextRecord = z.infer<typeof PoContextRecordSchema>;
export const PoContextArraySchema = z.array(PoContextRecordSchema).max(50);

const REQUIRED_SUPPLY_ORDER_HEADERS = [
  "po_id", "supplier_id", "raw_material_id", "order_date", "order_quantity",
  "unit_cost", "delivery_date_planned", "delivery_date_actual", "total_cost",
] as const;
const REQUIRED_KPI_HEADERS = [
  "po_id", "supplier", "order_date", "delivery_date", "item_category",
  "order_status", "quantity", "unit_price", "negotiated_price", "defective_units", "compliance",
] as const;

export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

interface CsvTable { readonly headers: readonly string[]; readonly rows: ReadonlyArray<Readonly<Record<string, string>>> }

/** Minimal RFC4180-style CSV parse (quoted commas/escaped quotes). Throws on unterminated quotes. */
export function parseCsvTable(csv: string): CsvTable {
  const grid: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && csv[i + 1] === "\n") i += 1;
      row.push(field); grid.push(row); row = []; field = "";
    } else field += char;
  }
  if (quoted) throw new Error("Malformed CSV: unterminated quoted field");
  if (field.length > 0 || row.length > 0) { row.push(field); grid.push(row); }
  if (grid.length === 0) return { headers: [], rows: [] };
  const headers = grid[0].map((header) => normalizeHeader(header.replace(/^\uFEFF/, "")));
  const rows = grid.slice(1)
    .filter((values) => values.some((value) => value.trim() !== ""))
    .map((values) => Object.fromEntries(headers.map((header, column) => [header, (values[column] ?? "").trim()])));
  return { headers, rows };
}

function requireHeaders(headers: readonly string[], required: readonly string[], sourceFile: string): void {
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length > 0) throw new Error(`Missing required header(s) ${missing.join(", ")} in ${sourceFile}`);
}

const textOrNull = (value: string | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
};

const numberOrNull = (value: string | undefined): number | null => {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const rateOrNull = (value: string | undefined): number | null => {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed <= 1 ? parsed : null;
};

const booleanOrNull = (value: string | undefined): boolean | null => {
  const trimmed = (value ?? "").trim();
  if (trimmed === "1" || trimmed.toLowerCase() === "true") return true;
  if (trimmed === "0" || trimmed.toLowerCase() === "false") return false;
  return null;
};

/** Maps supply-chain procurement orders, left-joining supplier/product masters on their own IDs. */
export function mapSupplyChainOrders(
  ordersCsv: string,
  supplierMasterCsv: string,
  productMasterCsv: string,
  sourceFile = "procurement_orders.csv",
): PoContextRecord[] {
  const orders = parseCsvTable(ordersCsv);
  requireHeaders(orders.headers, REQUIRED_SUPPLY_ORDER_HEADERS, sourceFile);
  const suppliers = supplierMasterCsv.trim() ? parseCsvTable(supplierMasterCsv) : { headers: [], rows: [] };
  const products = productMasterCsv.trim() ? parseCsvTable(productMasterCsv) : { headers: [], rows: [] };
  const supplierById = new Map(suppliers.rows.map((row) => [row.supplier_id ?? "", row]));
  const productById = new Map(products.rows.map((row) => [row.product_id ?? "", row]));
  return orders.rows.map((row) => PoContextRecordSchema.parse({
    poId: (row.po_id ?? "").trim(),
    sourceDataset: "supply-chain",
    supplierId: textOrNull(row.supplier_id),
    supplierName: textOrNull(supplierById.get((row.supplier_id ?? "").trim())?.supplier_name),
    materialId: textOrNull(row.raw_material_id),
    productName: textOrNull(productById.get((row.raw_material_id ?? "").trim())?.product_name),
    itemCategory: textOrNull(productById.get((row.raw_material_id ?? "").trim())?.category),
    orderDate: textOrNull(row.order_date),
    plannedDeliveryDate: textOrNull(row.delivery_date_planned),
    actualDeliveryDate: textOrNull(row.delivery_date_actual),
    quantity: numberOrNull(row.order_quantity),
    unitCost: numberOrNull(row.unit_cost),
    negotiatedPrice: null,
    totalCost: numberOrNull(row.total_cost),
    orderStatus: null,
    defectiveUnits: null,
    compliance: null,
    supplierOnTimeRate: rateOrNull(supplierById.get((row.supplier_id ?? "").trim())?.on_time_delivery_rate),
    preferredSupplier: booleanOrNull(supplierById.get((row.supplier_id ?? "").trim())?.preferred_supplier_flag),
    provenance: { sourceDataset: "supply-chain", sourceFile },
  }));
}

/** Maps procurement-KPI rows standalone; never joins supply-chain lookups. */
export function mapProcurementKpiRows(kpiCsv: string, sourceFile = "Procurement KPI Analysis Dataset.csv"): PoContextRecord[] {
  const table = parseCsvTable(kpiCsv);
  requireHeaders(table.headers, REQUIRED_KPI_HEADERS, sourceFile);
  return table.rows.map((row) => PoContextRecordSchema.parse({
    poId: (row.po_id ?? "").trim(),
    sourceDataset: "procurement-kpi",
    supplierId: null,
    supplierName: textOrNull(row.supplier),
    materialId: null,
    productName: null,
    itemCategory: textOrNull(row.item_category),
    orderDate: textOrNull(row.order_date),
    plannedDeliveryDate: null,
    actualDeliveryDate: textOrNull(row.delivery_date),
    quantity: numberOrNull(row.quantity),
    unitCost: numberOrNull(row.unit_price),
    negotiatedPrice: numberOrNull(row.negotiated_price),
    totalCost: null,
    orderStatus: textOrNull(row.order_status),
    defectiveUnits: numberOrNull(row.defective_units),
    compliance: textOrNull(row.compliance),
    supplierOnTimeRate: null,
    preferredSupplier: null,
    provenance: { sourceDataset: "procurement-kpi", sourceFile },
  }));
}

export interface ContextInputs {
  readonly supplyOrdersCsv: string;
  readonly supplierMasterCsv: string;
  readonly productMasterCsv: string;
  readonly kpiCsv: string;
}

/** Builds the combined corpus: supply-chain records first, then KPI records. No cross-dataset joins. */
export function buildPoContext(inputs: ContextInputs): PoContextRecord[] {
  return [
    ...mapSupplyChainOrders(inputs.supplyOrdersCsv, inputs.supplierMasterCsv, inputs.productMasterCsv),
    ...mapProcurementKpiRows(inputs.kpiCsv),
  ];
}

/** Validates untrusted caller-supplied context (e.g. API body) without throwing. */
export function validatePoContextInput(value: unknown): PoContextRecord[] | null {
  const parsed = PoContextArraySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Builds a live operational baseline record from the currently selected PO.
 * This is the deterministic fact the model should compare a supplier message
 * against (current ETA / quantity / supplier), not a corpus lookup. It is
 * always validated through PoContextRecordSchema before use.
 */
export function operationalPoContextRecord(input: {
  readonly poId: string;
  readonly supplierId?: string | null;
  readonly supplierName?: string | null;
  readonly quantity?: number | null;
  readonly plannedDeliveryDate?: string | null;
  readonly orderStatus?: string | null;
}): PoContextRecord {
  return PoContextRecordSchema.parse({
    poId: input.poId,
    sourceDataset: "operational",
    supplierId: input.supplierId ?? null,
    supplierName: input.supplierName ?? null,
    materialId: null,
    productName: null,
    itemCategory: null,
    orderDate: null,
    plannedDeliveryDate: input.plannedDeliveryDate ?? null,
    actualDeliveryDate: null,
    quantity: input.quantity ?? null,
    unitCost: null,
    negotiatedPrice: null,
    totalCost: null,
    orderStatus: input.orderStatus ?? null,
    defectiveUnits: null,
    compliance: null,
    supplierOnTimeRate: null,
    preferredSupplier: null,
    provenance: { sourceDataset: "operational", sourceFile: "operational-state" },
  });
}

/**
 * Renders validated PO records as delimited factual context for the model.
 * The supplier message itself is always sent separately as the proposal source.
 */
export function formatPoContextForPrompt(records: readonly PoContextRecord[]): string {
  if (records.length === 0) return "";
  const lines = records.slice(0, 50).map((record) => {
    const facts = [
      `poId=${record.poId}`,
      record.supplierName ? `supplier=${record.supplierName}` : null,
      record.supplierId ? `supplierId=${record.supplierId}` : null,
      record.orderDate ? `orderDate=${record.orderDate}` : null,
      record.plannedDeliveryDate ? `plannedDelivery=${record.plannedDeliveryDate}` : null,
      record.actualDeliveryDate ? `actualDelivery=${record.actualDeliveryDate}` : null,
      record.quantity !== null ? `quantity=${record.quantity}` : null,
      record.unitCost !== null ? `unitCost=${record.unitCost}` : null,
      record.negotiatedPrice !== null ? `negotiatedPrice=${record.negotiatedPrice}` : null,
      record.orderStatus ? `status=${record.orderStatus}` : null,
      record.itemCategory ? `category=${record.itemCategory}` : null,
    ].filter((fact): fact is string => fact !== null);
    return `- [${record.sourceDataset}] ${facts.join(" | ")}`;
  });
  return `<po_context>\n${lines.join("\n")}\n</po_context>`;
}
