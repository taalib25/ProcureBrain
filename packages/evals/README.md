# Deterministic exception evaluations

`../../data/gold/exceptions.json` contains the fixed acceptance scenario. The
failure-injection suite covers duplicate IDs, unknown purchase orders, invalid
dates and quantities, receipts before confirmation, and equal-timestamp event
ordering. The domain engine is intentionally pure; callers provide `now` and
the follow-up threshold.
