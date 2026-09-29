import { EventProposalSchema, SupplierCommitmentSchema, type EventProposal, type SupplierCommitment, type ReviewState } from "./schema";
import { PoContextArraySchema, type PoContextRecord } from "./context";
import { runCachedAnalysis, type AnalysisCache, type AnalysisRun, type ModelRunner } from "../../analysis-cache/src";

export interface ExtractionAdapter {
  extract(message: string, poContext?: readonly PoContextRecord[]): unknown | Promise<unknown>;
}

export interface ProposalContext {
  readonly sourceRecordId: string;
  readonly entityId?: string | null;
  readonly sourceAlreadyProcessed?: boolean;
  readonly matchingPoCount?: number;
}

const stateFor = (commitment: SupplierCommitment, context: ProposalContext): ReviewState => {
  if (context.sourceAlreadyProcessed) return "DUPLICATE_SOURCE";
  if (context.matchingPoCount === 0 || (commitment.poReference !== null && context.entityId === null)) return "UNKNOWN_PO";
  if (context.matchingPoCount !== undefined && context.matchingPoCount > 1) return "AMBIGUOUS_PO";
  if (commitment.confidence < 0.7) return "LOW_CONFIDENCE";
  return "VALID";
};

export interface ProposalPoContext {
  readonly poContext?: readonly PoContextRecord[];
}

/** Converts an adapter result into a reviewable proposal; it never creates or persists an event. */
export async function proposeSupplierCommitment(
  message: string,
  context: ProposalContext,
  adapter: ExtractionAdapter,
  options: ProposalPoContext = {},
): Promise<EventProposal> {
  const validated = PoContextArraySchema.safeParse(options.poContext ?? []);
  if (!validated.success) {
    return EventProposalSchema.parse({ sourceRecordId: context.sourceRecordId, sourceText: message, commitment: null, state: "INVALID_SCHEMA", entityId: context.entityId ?? null, reason: "Invalid purchase-order context" });
  }
  const poContext = validated.data;
  let raw: unknown;
  try {
    raw = await adapter.extract(message, poContext);
  } catch {
    return EventProposalSchema.parse({ sourceRecordId: context.sourceRecordId, sourceText: message, commitment: null, state: "REQUIRES_REVIEW", entityId: context.entityId ?? null, reason: "Extraction adapter failed" });
  }
  const parsed = SupplierCommitmentSchema.safeParse(raw);
  if (!parsed.success) {
    return EventProposalSchema.parse({ sourceRecordId: context.sourceRecordId, sourceText: message, commitment: null, state: "INVALID_SCHEMA", entityId: context.entityId ?? null, reason: parsed.error.message });
  }
  const commitment = parsed.data;
  const state = stateFor(commitment, context);
  return EventProposalSchema.parse({ sourceRecordId: context.sourceRecordId, sourceText: message, commitment, state, entityId: context.entityId ?? null, reason: state === "VALID" ? null : `Proposal requires ${state.toLowerCase()}` });
}

/** Explicit test/local adapter for already structured output; production adapters can implement the same boundary. */
export const structuredExtractionAdapter = (value: unknown): ExtractionAdapter => ({ extract: () => value });

export interface CachedProposalOptions {
  readonly cache: AnalysisCache<EventProposal>;
  readonly model: string;
  readonly provider: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
}

/** Supplier extraction with a versioned cache; cache hits do not invoke the extraction adapter/model. */
export async function proposeCachedSupplierCommitment(
  message: string,
  context: ProposalContext,
  adapter: ExtractionAdapter,
  options: CachedProposalOptions,
  poOptions: ProposalPoContext = {},
): Promise<{ readonly proposal: EventProposal; readonly run: AnalysisRun<EventProposal>; readonly cacheHit: boolean }> {
  const validated = PoContextArraySchema.safeParse(poOptions.poContext ?? []);
  const poContext = validated.success ? validated.data : [];
  const model: ModelRunner<EventProposal> = {
    run: async () => ({ result: await proposeSupplierCommitment(message, context, adapter, { poContext }) }),
  };
  const cached = await runCachedAnalysis({
    // Context can change the review outcome, so it is part of the cache identity.
    // PO facts also change the model input, so validated context joins the cache identity.
    input: poContext.length > 0 ? JSON.stringify({ message, context, poContext }) : JSON.stringify({ message, context }),
    mediaType: "text",
    analysisType: "supplier_commitment_extraction",
    model: options.model,
    provider: options.provider,
    promptVersion: options.promptVersion,
    schemaVersion: options.schemaVersion,
  }, options.cache, model);
  return { proposal: cached.run.result ?? EventProposalSchema.parse({
    sourceRecordId: context.sourceRecordId,
    sourceText: message,
    commitment: null,
    state: "REQUIRES_REVIEW",
    entityId: context.entityId ?? null,
    reason: cached.run.error ?? "Cached extraction has no result",
  }), run: cached.run, cacheHit: cached.cacheHit };
}
