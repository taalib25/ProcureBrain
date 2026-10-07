import type { SupplierCommitment } from "./schema";

/**
 * Authored-realistic supplier evaluation set. These are hand-written in
 * business prose (subjects, signatures, forwarded threads), deliberately
 * distinct from the synthetic template families in dataset.ts, and NOT real
 * supplier traffic: strong scores here do not establish production accuracy.
 *
 * Splits are scenario-grouped and use their own tuning/final namespace so
 * they can never be confused with the synthetic development/holdout sets.
 * Every extractable row carries an explicit reviewRequired label that does
 * not depend on model confidence, and every evidence string is a verbatim
 * substring of its message (enforced by test).
 */
export type RealisticSplit = "tuning" | "final";

export interface RealisticMessage {
  readonly id: string;
  readonly message: string;
  readonly scenario: string;
  readonly split: RealisticSplit;
}

export interface RealisticGold {
  readonly id: string;
  readonly expected: SupplierCommitment | null;
  readonly reviewRequired: boolean;
  readonly scenario: string;
  readonly split: RealisticSplit;
}

interface Entry {
  readonly message: string;
  readonly scenario: string;
  readonly split: RealisticSplit;
  readonly expected: SupplierCommitment | null;
  readonly reviewRequired: boolean;
}

const entries: readonly Entry[] = [
  {
    message: "Subject: PO-4101 delivery moved\n\nHi, quick update on PO-4101: the factory pushed us back, and the revised delivery date is 2026-11-18. Sorry for the shift — everything else on the order stays the same.\n\nBest,\nMarco (Alpine Fasteners)",
    scenario: "eta-clear",
    split: "tuning",
    expected: { poReference: "PO-4101", eta: "2026-11-18", quantity: null, type: "eta_change", confidence: 0.95, evidence: ["revised delivery date is 2026-11-18"] },
    reviewRequired: false,
  },
  {
    message: "Subject: FW: PO-4102 — new ETA\n\nTeam, forwarding the supplier's note for PO-4102. They confirmed arrival on 2026-12-02, moved from 2026-11-20 due to port congestion. Please update the PO.\n\nThanks,\nPriya",
    scenario: "eta-clear",
    split: "tuning",
    expected: { poReference: "PO-4102", eta: "2026-12-02", quantity: null, type: "eta_change", confidence: 0.93, evidence: ["confirmed arrival on 2026-12-02"] },
    reviewRequired: false,
  },
  {
    message: "Subject: PO-4103 delayed\n\nHello, I'm afraid PO-4103 will now arrive on November 25, 2026 instead of November 10. The goods are finished and waiting on a container.\n\nRegards,\nElena",
    scenario: "eta-written-date",
    split: "tuning",
    expected: { poReference: "PO-4103", eta: "2026-11-25", quantity: null, type: "eta_change", confidence: 0.9, evidence: ["arrive on November 25, 2026"] },
    reviewRequired: false,
  },
  {
    message: "Subject: Re: PO-4104 delivery\n\nGood news and bad news for PO-4104. The new confirmed date is 12 Dec 2026 — two weeks earlier than we feared, though still later than the original 20 Nov. Let me know if that works.\n\n— Sam",
    scenario: "eta-written-date",
    split: "tuning",
    expected: { poReference: "PO-4104", eta: "2026-12-12", quantity: null, type: "eta_change", confidence: 0.9, evidence: ["new confirmed date is 12 Dec 2026"] },
    reviewRequired: false,
  },
  {
    message: "Subject: Short shipment on PO-4105\n\nHi, on PO-4105 we can only ship 60 of the 100 units this month — raw material shortage on our side. The remaining 40 will follow in January, exact date TBC.\n\nAna",
    scenario: "quantity-clear",
    split: "tuning",
    expected: { poReference: "PO-4105", eta: null, quantity: 60, type: "quantity_change", confidence: 0.92, evidence: ["only ship 60 of the 100 units"] },
    reviewRequired: false,
  },
  {
    message: "Subject: PO-4106 quantity revision\n\nPlease revise PO-4106 down to 25 units. Our line can only complete 25 before the holiday shutdown; we will rebook the balance as a separate order if you still need it.\n\nRegards,\nChen",
    scenario: "quantity-clear",
    split: "tuning",
    expected: { poReference: "PO-4106", eta: null, quantity: 25, type: "quantity_change", confidence: 0.93, evidence: ["revise PO-4106 down to 25 units"] },
    reviewRequired: false,
  },
  {
    message: "Subject: PO-4107 ready to ship\n\nWe have eight (8) units of PO-4107 packed and leaving our warehouse on 2026-11-20. Tracking will follow tomorrow.\n\n— Warehouse team",
    scenario: "quantity-words",
    split: "tuning",
    expected: { poReference: "PO-4107", eta: "2026-11-20", quantity: 8, type: "new_commitment", confidence: 0.93, evidence: ["eight (8) units of PO-4107 packed"] },
    reviewRequired: false,
  },
  {
    message: "Subject: PO-4108 on track\n\nJust confirming PO-4108 is still on track for 2026-12-05. No changes on our side.\n\n— Tomas",
    scenario: "confirm-no-change",
    split: "tuning",
    expected: { poReference: "PO-4108", eta: "2026-12-05", quantity: null, type: "general_update", confidence: 0.9, evidence: ["still on track for 2026-12-05"] },
    reviewRequired: false,
  },
  {
    message: "Subject: delays\n\nHi, PO-4109 and PO-4110 are both delayed by about a week. New dates to follow once the carrier confirms. Sorry about this.\n\n— Fatima",
    scenario: "multiple-po",
    split: "tuning",
    expected: null,
    reviewRequired: true,
  },
  {
    message: "Subject: order delayed\n\nHi, your order placed last month is delayed to mid-December. I will send the exact date as soon as the factory confirms. Thanks for your patience.",
    scenario: "no-reference",
    split: "tuning",
    expected: null,
    reviewRequired: true,
  },
  {
    message: "Subject: PO-9999 moved\n\nRegarding PO-9999, delivery moved to 2026-12-01. Let me know if you need anything else.\n\n— Rob",
    scenario: "unknown-po",
    split: "tuning",
    expected: { poReference: "PO-9999", eta: "2026-12-01", quantity: null, type: "eta_change", confidence: 0.9, evidence: ["delivery moved to 2026-12-01"] },
    reviewRequired: true,
  },
  {
    message: "Subject: Fwd: PO-4111 dates (please read latest first)\n\nLatest update from supplier, 28 Oct: ignore the quoted ETA 2026-10-01 below — the correct date for PO-4111 is 2026-11-30. The October date was from an old quotation.\n\n--- Forwarded ---\n> ETA for PO-4111: 2026-10-01 (per September quote).",
    scenario: "forwarded-correction",
    split: "tuning",
    expected: { poReference: "PO-4111", eta: "2026-11-30", quantity: null, type: "eta_change", confidence: 0.88, evidence: ["correct date for PO-4111 is 2026-11-30"] },
    reviewRequired: false,
  },
  {
    message: "Subject: PO-4112 date conflict\n\nPO-4112: our warehouse says 2026-12-03 but the forwarder says 2026-12-10. Waiting on the factory to confirm which one is right — will update you tomorrow.",
    scenario: "conflicting-dates",
    split: "tuning",
    expected: null,
    reviewRequired: true,
  },
  {
    message: "Subject: PO-4113 shipping soon\n\nGood news — PO-4113 will ship next Friday. Tracking to follow once it leaves.",
    scenario: "relative-date",
    split: "tuning",
    expected: { poReference: "PO-4113", eta: null, quantity: null, type: "general_update", confidence: 0.6, evidence: ["will ship next Friday"] },
    reviewRequired: true,
  },
  {
    message: "Subject: PO-4114 confirmed\n\nPO-4114 confirmed for 2026-12-15, 40 units. Thanks!\n\n— Dana",
    scenario: "duplicate-delivery",
    split: "tuning",
    expected: { poReference: "PO-4114", eta: "2026-12-15", quantity: 40, type: "new_commitment", confidence: 0.95, evidence: ["PO-4114 confirmed for 2026-12-15"] },
    reviewRequired: false,
  },
  {
    message: "Subject: PO-4114 confirmed\n\nPO-4114 confirmed for 2026-12-15, 40 units. Thanks!\n\n— Dana",
    scenario: "duplicate-delivery",
    split: "tuning",
    expected: { poReference: "PO-4114", eta: "2026-12-15", quantity: 40, type: "new_commitment", confidence: 0.95, evidence: ["PO-4114 confirmed for 2026-12-15"] },
    reviewRequired: false,
  },
  {
    message: "Subject: PO-4115 quantity range\n\nFor PO-4115 we can do between 45 and 55 units — final count confirmed on Monday after the production run.",
    scenario: "ambiguous-quantity",
    split: "tuning",
    expected: null,
    reviewRequired: true,
  },
  {
    message: "Subject: PO-4116 pulled forward\n\nGood news on PO-4116: the line finished early, so delivery is pulled forward to 2026-11-05 from 2026-11-20. Invoice follows separately.\n\n— Greta",
    scenario: "eta-clear",
    split: "final",
    expected: { poReference: "PO-4116", eta: "2026-11-05", quantity: null, type: "eta_change", confidence: 0.94, evidence: ["pulled forward to 2026-11-05"] },
    reviewRequired: false,
  },
  {
    message: "Subject: Revised date PO-4117\n\nPO-4117 update: unfortunately we have to push delivery to 2027-01-08. The delay is a customs hold, now cleared, and the goods ship this week.\n\nRegards,\nOmar",
    scenario: "eta-clear",
    split: "final",
    expected: { poReference: "PO-4117", eta: "2027-01-08", quantity: null, type: "eta_change", confidence: 0.93, evidence: ["push delivery to 2027-01-08"] },
    reviewRequired: false,
  },
  {
    message: "Subject: PO-4118 new date\n\nHello — PO-4118 will now be delivered on January 6, 2027. Apologies for the third change; the component shortage is finally resolved.\n\n— Ingrid",
    scenario: "eta-written-date",
    split: "final",
    expected: { poReference: "PO-4118", eta: "2027-01-06", quantity: null, type: "eta_change", confidence: 0.9, evidence: ["delivered on January 6, 2027"] },
    reviewRequired: false,
  },
  {
    message: "Subject: Partial shipment PO-4119\n\nPO-4119: 15 units ship today, tracking 1Z8845. The balance of 25 follows on 2026-12-18 barring weather delays.\n\n— Logistics",
    scenario: "quantity-clear",
    split: "final",
    expected: { poReference: "PO-4119", eta: "2026-12-18", quantity: 15, type: "quantity_change", confidence: 0.9, evidence: ["15 units ship today"] },
    reviewRequired: false,
  },
  {
    message: "Subject: PO-4120 reduced\n\nWe have to reduce PO-4120 to 12 units — the rest of the batch failed inspection. A credit note for the shortfall is attached.\n\n— Quality team",
    scenario: "quantity-clear",
    split: "final",
    expected: { poReference: "PO-4120", eta: null, quantity: 12, type: "quantity_change", confidence: 0.92, evidence: ["reduce PO-4120 to 12 units"] },
    reviewRequired: false,
  },
  {
    message: "Subject: PO-4121 dispatch\n\nTwelve (12) cartons for PO-4121 leave Rotterdam on 2026-11-28. Documents attached.\n\n— Export desk",
    scenario: "quantity-words",
    split: "final",
    expected: { poReference: "PO-4121", eta: "2026-11-28", quantity: 12, type: "new_commitment", confidence: 0.93, evidence: ["Twelve (12) cartons for PO-4121"] },
    reviewRequired: false,
  },
  {
    message: "Subject: Re: PO-4122\n\nStill expecting PO-4122 on Dec 20, 2026. Will flag immediately if anything changes.\n\n— Yusuf",
    scenario: "confirm-no-change",
    split: "final",
    expected: { poReference: "PO-4122", eta: "2026-12-20", quantity: null, type: "general_update", confidence: 0.88, evidence: ["expecting PO-4122 on Dec 20, 2026"] },
    reviewRequired: false,
  },
  {
    message: "Subject: several orders delayed\n\nPO-4123, PO-4124 and PO-4125 are all held at the port. Expect one consolidated update with new dates tomorrow morning.",
    scenario: "multiple-po",
    split: "final",
    expected: null,
    reviewRequired: true,
  },
  {
    message: "Subject: valves order\n\nThe valves order is running about two weeks late because of a coating issue. New date early January — confirming exact day Friday.",
    scenario: "no-reference",
    split: "final",
    expected: null,
    reviewRequired: true,
  },
  {
    message: "Subject: PO-41O1 delivery\n\nPO-41O1 delivery is set for 2026-12-09. Please confirm receipt of this message.",
    scenario: "confusable-reference",
    split: "final",
    expected: null,
    reviewRequired: true,
  },
  {
    message: "Subject: Fwd: PO-4126 quantity correction\n\nCorrection to my earlier note: the confirmed quantity for PO-4126 is 18 units, not 30. The 30 figure included another customer's allocation by mistake. Date unchanged at 2026-12-08.\n\n— Beatriz",
    scenario: "forwarded-correction",
    split: "final",
    expected: { poReference: "PO-4126", eta: null, quantity: 18, type: "quantity_change", confidence: 0.88, evidence: ["confirmed quantity for PO-4126 is 18 units"] },
    reviewRequired: false,
  },
  {
    message: "Subject: PO-4127 quantity mismatch\n\nPO-4127: the email body says 20 units but the attached order confirmation says 25. Please advise which is correct before we load the truck.",
    scenario: "conflicting-quantity",
    split: "final",
    expected: null,
    reviewRequired: true,
  },
  {
    message: "Subject: PO-4128 packing list\n\nAttached is the final packing list for PO-4128 with the per-carton breakdown. Let me know if customs needs anything else.",
    scenario: "attachment-only",
    split: "final",
    expected: { poReference: "PO-4128", eta: null, quantity: null, type: "general_update", confidence: 0.7, evidence: ["final packing list for PO-4128"] },
    reviewRequired: false,
  },
  {
    message: "Subject: Happy holidays\n\nOur office is closed Dec 24 through Jan 2. Wishing you a restful break!\n\n— The team at Brunner & Sohn",
    scenario: "irrelevant",
    split: "final",
    expected: null,
    reviewRequired: true,
  },
  {
    message: "Subject: PO-4129 cancelled\n\nPO-4129 for 40 units due 2026-12-20 is cancelled; replacement date pending. The deposit will be credited to your next order.\n\n— Accounts",
    scenario: "cancelled",
    split: "final",
    expected: { poReference: "PO-4129", eta: null, quantity: null, type: "general_update", confidence: 0.85, evidence: ["is cancelled; replacement date pending"] },
    reviewRequired: false,
  },
];

export function realisticDataset(): { messages: RealisticMessage[]; gold: RealisticGold[] } {
  const messages = entries.map((entry, index) => ({
    id: `rea-${String(index + 1).padStart(4, "0")}`,
    message: entry.message,
    scenario: entry.scenario,
    split: entry.split,
  }));
  const gold = entries.map((entry, index) => ({
    id: `rea-${String(index + 1).padStart(4, "0")}`,
    expected: entry.expected,
    reviewRequired: entry.reviewRequired,
    scenario: entry.scenario,
    split: entry.split,
  }));
  return { messages, gold };
}

export function realisticMessagesById(): Record<string, string> {
  return Object.fromEntries(realisticDataset().messages.map((row) => [row.id, row.message]));
}
