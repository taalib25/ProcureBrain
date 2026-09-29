import type { EventInput } from "./types";

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** Stable, content-addressed key. It intentionally excludes ingestion time. */
export function idempotencyKey(input: EventInput): string {
  // Source records identify provenance, not the operational fact. Excluding it
  // makes a re-import of the same row idempotent even when it gets a new source id.
  const content = stable({ entityId: input.entityId, eventType: input.eventType, occurredAt: input.occurredAt, payload: input.payload });
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v1_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function canonicalEventId(input: EventInput): string {
  return `evt_${idempotencyKey(input)}`;
}
