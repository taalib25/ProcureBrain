import { z } from "zod";

export const commitmentTypes = ["new_commitment", "eta_change", "quantity_change", "general_update"] as const;
export const reviewStates = [
  "VALID",
  "INVALID_SCHEMA",
  "UNKNOWN_PO",
  "AMBIGUOUS_PO",
  "LOW_CONFIDENCE",
  "CONFLICTING_VALUES",
  "DUPLICATE_SOURCE",
  "REQUIRES_REVIEW",
] as const;

/** The only extraction shape accepted at the AI boundary. */
export const IsoCalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ETA must be an ISO calendar date").refine(value => {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}, "ETA must be a real calendar date");

export const SupplierCommitmentSchema = z.object({
  poReference: z.string().trim().min(1).nullable(),
  eta: IsoCalendarDateSchema.nullable(),
  quantity: z.number().finite().nonnegative().nullable(),
  type: z.enum(commitmentTypes),
  confidence: z.number().finite().min(0).max(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
}).strict();

export type SupplierCommitment = z.infer<typeof SupplierCommitmentSchema>;
export type ReviewState = (typeof reviewStates)[number];

export const EventProposalSchema = z.object({
  sourceRecordId: z.string().trim().min(1),
  sourceText: z.string().min(1),
  commitment: SupplierCommitmentSchema.nullable(),
  state: z.enum(reviewStates),
  entityId: z.string().trim().min(1).nullable(),
  reason: z.string().trim().min(1).nullable(),
}).strict();

export type EventProposal = z.infer<typeof EventProposalSchema>;
