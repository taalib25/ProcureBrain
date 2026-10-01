import { z } from "zod";
import { PoContextArraySchema } from "../../../packages/ai/src/context";

const id = z.string().trim().min(1);
const text = z.string().refine(value => value.trim().length > 0, "Text must not be empty");
const row = z.object({ row: z.number().int().positive(), values: z.record(z.string()) }).strict();
const reference = z.object({ entityId: id, poNumber: id, aliases: z.array(id).optional() }).strict();

export const ImportRequestSchema = z.object({
  csv: text.optional(), sourceRecordId: id.optional(), rows: z.array(row).optional(),
}).strict().refine(value => (value.csv !== undefined) !== (value.rows !== undefined), "Provide either csv or rows");

export const CsvAnalysisRequestSchema = z.object({
  csv: text, sourceRecordId: id.optional(), purchaseOrders: z.array(reference).optional(), retry: z.boolean().optional(),
}).strict();

export const SupplierTextRequestSchema = z.object({
  text, sourceRecordId: id.optional(), entityId: id.nullable().optional(),
  matchingPoCount: z.number().int().nonnegative().optional(),
  poContext: PoContextArraySchema.optional(), retry: z.boolean().optional(),
}).strict();

export const ApprovalRequestSchema = z.object({ eta: z.string().optional() }).strict();
