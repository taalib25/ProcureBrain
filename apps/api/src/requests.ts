import { z } from "zod";
import { PoContextArraySchema } from "../../../packages/ai/src/context";
import { TEXT_CHANNEL_SOURCES } from "../../../packages/ingestion/src/sources";

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

const provenance = z.record(z.unknown()).optional();

export const SupplierTextRequestSchema = z.object({
  text, sourceRecordId: id.optional(), entityId: id.nullable().optional(),
  matchingPoCount: z.number().int().nonnegative().optional(),
  poContext: PoContextArraySchema.optional(), retry: z.boolean().optional(),
  sourceType: z.enum(TEXT_CHANNEL_SOURCES).optional(), provenance,
}).strict();

export const DocumentBindRequestSchema = z.object({ entityId: id }).strict();

export const MessageCreateSchema = z.object({
  channel: z.enum(TEXT_CHANNEL_SOURCES),
  sender: z.string().trim().min(1).max(320).optional(),
  recipients: z.array(z.string().trim().max(320)).max(20).optional(),
  subject: z.string().trim().max(500).optional(),
  text,
  sentAt: z.string().max(100).optional(),
  receivedAt: z.string().max(100).optional(),
  externalMessageId: id.max(200).optional(),
  threadId: z.string().trim().max(200).optional(),
}).strict();

export const MessageLinkSchema = z.object({ entityId: id }).strict();

const optionalText = z.string().trim().max(200).optional();

export const SupplierCreateSchema = z.object({
  supplierCode: id.max(60),
  name: z.string().trim().min(1).max(200),
  primaryEmail: z.string().trim().email().max(200).optional(),
  emailDomain: z.string().trim().max(200).optional(),
  phone: optionalText,
  country: optionalText,
  currency: z.string().trim().max(10).optional(),
  defaultPaymentTerms: optionalText,
  status: z.enum(["active", "blocked"]).optional(),
}).strict();

export const ApprovalRequestSchema = z.object({ eta: z.string().optional() }).strict();

export const ProposalApproveSchema = z.object({ eta: z.string().optional(), quantity: z.number().optional() }).strict();

export const ProposalEditSchema = z.object({ eta: z.string().optional(), quantity: z.number().optional() }).strict()
  .refine((value) => value.eta !== undefined || value.quantity !== undefined, "Provide an edited eta or quantity");

export const ProposalRejectSchema = z.object({ reason: z.string().trim().max(500).optional(), reviewedBy: z.string().trim().max(200).optional() }).strict();
