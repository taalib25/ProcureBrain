import { CommunicationContextSchema, type CommunicationContext } from "./communication-context";
import { ZodError } from "zod";
import { EventProposalSchema, SupplierCommitmentSchema, type EventProposal, type SupplierCommitment, type ReviewState } from "./schema";
import { PoContextArraySchema, type PoContextRecord } from "./context";
import { runCachedAnalysis, type AnalysisCache, type AnalysisRun, type ModelRunner } from "../../analysis-cache/src";

export interface ExtractionAdapter {
  extract(message: string, poContext?: readonly PoContextRecord[], communicationContext?: CommunicationContext): unknown | Promise<unknown>;
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
  readonly communicationContext?: CommunicationContext;
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
  if (options.communicationContext?.olderThanKnownUpdate) {
    return EventProposalSchema.parse({ sourceRecordId: context.sourceRecordId, sourceText: message, commitment: null, state: "REQUIRES_REVIEW", entityId: context.entityId ?? null, reason: "A newer supplier message is already saved for this order. Check the latest message before updating the order." });
  }
  if (message.includes("[Unread attachments:")) {
    return EventProposalSchema.parse({ sourceRecordId: context.sourceRecordId, sourceText: message, commitment: null, state: "REQUIRES_REVIEW", entityId: context.entityId ?? null, reason: "This email has unread attachments. Check the files before changing the order." });
  }
  let raw: unknown;
  try {
    raw = await adapter.extract(message, poContext, options.communicationContext ? CommunicationContextSchema.parse(options.communicationContext) : undefined);
  } catch (error) {
    // Some provider adapters validate before returning. Invalid fields need clarification,
    // while transport/provider failures remain retryable by the surrounding worker.
    return EventProposalSchema.parse({ sourceRecordId: context.sourceRecordId, sourceText: message, commitment: null, state: error instanceof ZodError ? "INVALID_SCHEMA" : "REQUIRES_REVIEW", entityId: context.entityId ?? null, reason: error instanceof ZodError ? "Provider output failed schema validation" : "Extraction adapter failed" });
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
    run: async () => ({ result: await proposeSupplierCommitment(message, context, adapter, { poContext, communicationContext: poOptions.communicationContext }) }),
  };
  const cached = await runCachedAnalysis({
    // Context can change the review outcome, so it is part of the cache identity.
    // PO facts also change the model input, so validated context joins the cache identity.
    input: poContext.length > 0 ? JSON.stringify({ message, context, poContext, communicationContext: poOptions.communicationContext }) : JSON.stringify({ message, context, communicationContext: poOptions.communicationContext }),
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
