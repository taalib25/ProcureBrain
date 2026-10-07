/**
 * Source taxonomy and provenance contract for every ingestion channel.
 *
 * Design rule: channels are thin adapters. Each adapter fetches/decodes its
 * native payload into claim text plus provenance, then feeds the single
 * shared pipeline (extract → proposal → human approval → event). No adapter
 * writes canonical events directly, and every source record carries the
 * provenance its channel requires so reviewers can trace evidence.
 */

/** Every source_type the system writes today. CSV route values, message channels, and document channels. */
export const SOURCE_TYPES = [
  "purchase_orders",
  "supplier_updates",
  "receipts",
  "followups",
  "csv",
  "supplier_message",
  "supplier_email",
  "supplier_sms",
  "whatsapp",
  "supplier_image",
  "supplier_pdf",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/** Message channels: claim text arrives with a sender and a channel-side id. */
const REMOTE_CHANNEL_SOURCES = ["supplier_email", "supplier_sms", "whatsapp"] as const;
export type RemoteChannelSource = (typeof REMOTE_CHANNEL_SOURCES)[number];

/** Document channels: claim text is recovered by OCR from uploaded bytes. */
const DOCUMENT_SOURCES = ["supplier_image", "supplier_pdf"] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

/** Message channels selectable when submitting supplier text (default: pasted note). */
export const TEXT_CHANNEL_SOURCES = ["supplier_message", "supplier_email", "supplier_sms", "whatsapp"] as const;
export type TextChannelSource = (typeof TEXT_CHANNEL_SOURCES)[number];

export function isSourceType(value: string): value is SourceType {
  return (SOURCE_TYPES as readonly string[]).includes(value);
}

export function isRemoteChannelSource(value: string): value is RemoteChannelSource {
  return (REMOTE_CHANNEL_SOURCES as readonly string[]).includes(value);
}

export function isDocumentSource(value: string): value is DocumentSource {
  return (DOCUMENT_SOURCES as readonly string[]).includes(value);
}

/** Source type recorded when a document approval writes its event. */
export function documentSourceTypeForMime(mimeType: string): DocumentSource {
  return mimeType === "application/pdf" ? "supplier_pdf" : "supplier_image";
}

export interface SourceProvenance {
  readonly sender?: string;
  /** Original channel-side message/file id, used for idempotency per channel. */
  readonly channelMessageId?: string;
  /** When the supplier sent it (ISO-8601), distinct from our approval time. */
  readonly receivedAt?: string;
  readonly mimeType?: string;
  readonly filename?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDateTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/**
 * Validates provenance for a source type. Returns human-readable errors;
 * empty means the provenance is acceptable. Unknown extra fields are ignored
 * so channels can attach their own metadata without breaking validation.
 */
export function validateSourceProvenance(sourceType: string, provenance: unknown): string[] {
  if (!isSourceType(sourceType)) return [`Unknown source type "${sourceType}"`];
  if (provenance === undefined || provenance === null) {
    return isRemoteChannelSource(sourceType) || isDocumentSource(sourceType)
      ? [`Source "${sourceType}" requires provenance (sender/message id/received time)`]
      : [];
  }
  if (typeof provenance !== "object" || Array.isArray(provenance)) return ["Provenance must be an object"];
  const record = provenance as Partial<Record<keyof SourceProvenance, unknown>>;
  const errors: string[] = [];
  if (isRemoteChannelSource(sourceType)) {
    if (!isNonEmptyString(record.sender)) errors.push(`Source "${sourceType}" requires a sender`);
    if (!isNonEmptyString(record.channelMessageId)) errors.push(`Source "${sourceType}" requires a channelMessageId`);
    if (!isNonEmptyString(record.receivedAt) || !isIsoDateTime(record.receivedAt as string)) {
      errors.push(`Source "${sourceType}" requires receivedAt as an ISO date-time`);
    }
  }
  if (isDocumentSource(sourceType) && record.mimeType !== undefined && !isNonEmptyString(record.mimeType)) {
    errors.push(`Source "${sourceType}" requires mimeType as a non-empty string when provided`);
  }
  return errors;
}

export interface WhatsAppInboundPayload {
  readonly from?: unknown;
  readonly messageId?: unknown;
  readonly timestamp?: unknown;
  readonly text?: unknown;
}

export interface NormalizedChannelClaim {
  readonly claimText: string;
  readonly provenance: SourceProvenance;
}

/**
 * Example channel adapter: normalizes a WhatsApp Business Cloud API (or
 * Twilio-shaped) inbound text payload into claim text plus provenance.
 * Pure and deterministic: connection/auth/webhook verification live outside,
 * this maps one verified payload onto the shared pipeline contract.
 */
export function normalizeWhatsAppPayload(payload: WhatsAppInboundPayload): NormalizedChannelClaim | null {
  if (!isNonEmptyString(payload.text) || !isNonEmptyString(payload.from) || !isNonEmptyString(payload.messageId)) {
    return null;
  }
  const timestamp = typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp)
    ? new Date(payload.timestamp * 1000).toISOString()
    : typeof payload.timestamp === "string" && isIsoDateTime(payload.timestamp)
      ? new Date(payload.timestamp).toISOString()
      : new Date().toISOString();
  return {
    claimText: (payload.text as string).trim(),
    provenance: {
      sender: (payload.from as string).trim(),
      channelMessageId: (payload.messageId as string).trim(),
      receivedAt: timestamp,
    },
  };
}
