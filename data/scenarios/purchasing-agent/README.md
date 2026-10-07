# Purchasing agent practice pack

34 authored supplier messages, seven dataset-based order baselines, expected outcomes and mock extraction outputs. Contact addresses and dates are invented for practice. Historical actual delivery dates are excluded from baselines. This is a development/workflow pack, not real supplier traffic or an unseen model benchmark.

Open **Practice lab** in the dashboard, or follow [the complete walkthrough](../../../docs/PURCHASING_PRACTICE_GUIDE.md).

`cases.json` is the canonical pack. `purchase-orders.csv` imports its baseline order facts; `suppliers.json` supplies matching examples; `messages.txt` provides copyable messages. All are self-contained: the original local datasets are not required to run this pack.

```bash
pnpm --filter @procurebrain/api evaluate:purchasing-agent
```

This is offline and supplies mock extractions. For a real model run, follow the guide's explicit `--live-ai` instructions. Evaluation notifications remain previews.
