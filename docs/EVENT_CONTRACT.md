# Event Contract

Canonical event types are frozen for the MVP:

`PO_CREATED`, `SUPPLIER_ETA_CONFIRMED`, `SUPPLIER_ETA_CHANGED`, `SUPPLIER_QUANTITY_CONFIRMED`, `SUPPLIER_QUANTITY_REDUCED`, `GOODS_RECEIVED`, `FOLLOWUP_SENT`, `SUPPLIER_RESPONSE_RECEIVED`.

Every event has an immutable envelope with `id`, `entityType`, `entityId`, `eventType`, `occurredAt`, `ingestedAt`, `sourceRecordId`, `payload`, and `schemaVersion: 1`.

Reducer ordering is deterministic by `occurredAt`, then event ID. `occurredAt` represents operational time and must not be replaced by ingestion time.
