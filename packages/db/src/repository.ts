import type { Event } from "../../domain/src/events";
import { canonicalEvents, sourceRecords } from "./schema";
import { idempotencyKey } from "../../ingestion/src/idempotency";

export interface SourceRecordInsert { id: string; sourceType: string; sourceName?: string; content: string; metadata?: Record<string, unknown>; importedAt: Date; }
export interface EventRepository {
  insertSourceRecord(record: SourceRecordInsert): Promise<void>;
  insertEvents(events: readonly Event[]): Promise<number>;
}

/** Adapter boundary: the application supplies its configured Drizzle PostgreSQL client. */
export function createEventRepository(db: { insert(table: unknown): { values(values: unknown): { onConflictDoNothing(config?: unknown): Promise<unknown> } } }): EventRepository {
  return {
    async insertSourceRecord(record) {
      await db.insert(sourceRecords).values(record).onConflictDoNothing();
    },
    async insertEvents(events) {
      let inserted = 0;
      for (const event of events) {
        const key = idempotencyKey({ sourceRecordId: event.sourceRecordId, entityId: event.entityId, eventType: event.eventType, occurredAt: event.occurredAt, payload: event.payload });
        await db.insert(canonicalEvents).values({ ...event, idempotencyKey: key, occurredAt: new Date(event.occurredAt), ingestedAt: new Date(event.ingestedAt) }).onConflictDoNothing();
        inserted += 1;
      }
      return inserted;
    },
  };
}
