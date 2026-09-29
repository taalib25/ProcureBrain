import type { SupplierCommitment } from "./schema";

export type DatasetSplit = "development" | "validation" | "holdout";
export interface DatasetMessage { readonly id: string; readonly message: string; readonly templateFamily: string; readonly split: DatasetSplit }
export interface DatasetGold { readonly id: string; readonly expected: SupplierCommitment | null; readonly reviewState?: string; readonly templateFamily: string; readonly split: DatasetSplit }

const families = [
  "commit-confirm-direct", "commit-confirm-forwarded", "eta-iso-direct", "eta-iso-forwarded", "quantity-reduction-direct", "quantity-reduction-forwarded",
  "general-status-direct", "general-status-forwarded", "missing-po-date", "missing-po-quantity", "missing-po-confirmation", "ambiguous-date-numeric",
  "ambiguous-date-month-day", "ambiguous-date-two-options", "quantity-word-numeral", "quantity-range", "quantity-conflict", "forwarded-corrected-eta",
  "forwarded-corrected-quantity", "forwarded-stale-quote", "cancelled-commitment", "partial-shipment", "new-commitment-explicit",
  "eta-delay-explicit", "eta-early-explicit", "no-commitment-awaiting", "po-confusable-reference", "multiple-po-refs", "date-relative-only", "quantity-unspecified",
];
const templates: Readonly<Record<string, (i: number) => { message: string; expected: SupplierCommitment | null; reviewState?: string }>> = {
  "commit-confirm-direct": i => standard(i, `PO-${1000+i}: We confirm ${5+i} units will ship on 2027-01-${day(i)}.`, `PO-${1000+i}`, `2027-01-${day(i)}`, 5+i, "new_commitment"),
  "commit-confirm-forwarded": i => standard(i, `Forwarded: Re: order PO-${1100+i}. Supplier confirms ${8+i} cartons by 2027-02-${day(i)}.`, `PO-${1100+i}`, `2027-02-${day(i)}`, 8+i, "new_commitment"),
  "eta-iso-direct": i => standard(i, `For PO-${1200+i}, revised delivery date is 2027-03-${day(i)}.`, `PO-${1200+i}`, `2027-03-${day(i)}`, null, "eta_change"),
  "eta-iso-forwarded": i => standard(i, `Fwd: PO-${1300+i} — latest ETA: 2027-04-${day(i)} (earlier thread said 2027-04-${day((i+5)%28)}).`, `PO-${1300+i}`, `2027-04-${day(i)}`, null, "eta_change"),
  "quantity-reduction-direct": i => standard(i, `PO-${1400+i}: We can supply ${20+i} of the ${30+i} ordered units.`, `PO-${1400+i}`, null, 20+i, "quantity_change"),
  "quantity-reduction-forwarded": i => standard(i, `Forwarded update for PO-${1500+i}: revised quantity is ${12+i}; prior quote of ${22+i} is superseded.`, `PO-${1500+i}`, null, 12+i, "quantity_change"),
  "general-status-direct": i => standard(i, `PO-${1600+i}: Production is underway; we will update you after inspection.`, `PO-${1600+i}`, null, null, "general_update"),
  "general-status-forwarded": i => standard(i, `Fwd: Our team is checking production capacity for PO-${1700+i}; no date or quantity is confirmed.`, `PO-${1700+i}`, null, null, "general_update"),
  "missing-po-date": i => standard(i, `We confirm ${6+i} units will ship on 2027-05-${day(i)}.`, null, `2027-05-${day(i)}`, 6+i, "new_commitment"),
  "missing-po-quantity": i => standard(i, `Revised ETA for your order is 2027-06-${day(i)}; the purchase order number is not on this email.`, null, `2027-06-${day(i)}`, null, "eta_change"),
  "missing-po-confirmation": i => standard(i, `Confirmed: ${7+i} units are ready to ship, PO reference omitted.`, null, null, 7+i, "new_commitment"),
  "ambiguous-date-numeric": i => review(i, `PO-${1800+i}: ETA 04/05/2027. Please confirm which date format applies.`, "AMBIGUOUS_DATE"),
  "ambiguous-date-month-day": i => review(i, `PO-${1900+i}: Delivery will be on 5/6; year and date format are unclear.`, "AMBIGUOUS_DATE"),
  "ambiguous-date-two-options": i => review(i, `PO-${2000+i}: We may ship ${8+i} units on 2027-07-${day(i)} or 2027-07-${day((i+1)%28)}; date not finalized.`, "AMBIGUOUS_DATE"),
  "quantity-word-numeral": i => standard(i, `PO-${2100+i}: We can ship ${word(i+1)} (${i+1}) units on 2027-08-${day(i)}.`, `PO-${2100+i}`, `2027-08-${day(i)}`, i+1, "new_commitment"),
  "quantity-range": i => review(i, `PO-${2200+i}: We expect between ${10+i} and ${15+i} units; final quantity is pending.`, "AMBIGUOUS_QUANTITY"),
  "quantity-conflict": i => review(i, `PO-${2300+i}: Body says ${10+i} units, attached note says ${20+i}; please verify.`, "CONFLICTING_VALUES"),
  "forwarded-corrected-eta": i => standard(i, `Fwd chain: PO-${2400+i}. Ignore quoted ETA 2027-09-${day((i+4)%28)}; latest supplier update confirms 2027-09-${day(i)}.`, `PO-${2400+i}`, `2027-09-${day(i)}`, null, "eta_change"),
  "forwarded-corrected-quantity": i => standard(i, `Fwd chain for PO-${2500+i}. Quoted ${30+i}; correction from supplier: ${18+i} units.`, `PO-${2500+i}`, null, 18+i, "quantity_change"),
  "forwarded-stale-quote": i => standard(i, `PO-${2600+i}: Latest message says no commitment yet. Quoted text: “ship ${7+i} units by 2027-10-${day(i)}”.`, `PO-${2600+i}`, null, null, "general_update"),
  "cancelled-commitment": i => standard(i, `PO-${2700+i}: The previously confirmed ${9+i} units for 2027-11-${day(i)} are cancelled; replacement date pending.`, `PO-${2700+i}`, null, null, "general_update"),
  "partial-shipment": i => standard(i, `PO-${2800+i}: ${10+i} units shipped today; the remaining ${5+i} will follow on 2027-12-${day(i)}.`, `PO-${2800+i}`, `2027-12-${day(i)}`, 10+i, "quantity_change"),
  "new-commitment-explicit": i => standard(i, `We accept PO-${2900+i}: ${11+i} pieces, delivery 2028-01-${day(i)}.`, `PO-${2900+i}`, `2028-01-${day(i)}`, 11+i, "new_commitment"),
  "eta-delay-explicit": i => standard(i, `PO-${3000+i} is delayed; new confirmed arrival is 2028-02-${day(i)}.`, `PO-${3000+i}`, `2028-02-${day(i)}`, null, "eta_change"),
  "eta-early-explicit": i => standard(i, `Good news for PO-${3100+i}: delivery pulled forward to 2028-03-${day(i)}.`, `PO-${3100+i}`, `2028-03-${day(i)}`, null, "eta_change"),
  "no-commitment-awaiting": i => standard(i, `PO-${3200+i}: We are waiting for factory confirmation and cannot commit to a ship date.`, `PO-${3200+i}`, null, null, "general_update"),
  "po-confusable-reference": i => review(i, `PO-${3300+i} / PO-${3300+i}I: ${10+i} units scheduled 2028-04-${day(i)}; reference needs confirmation.`, "AMBIGUOUS_PO"),
  "multiple-po-refs": i => review(i, `PO-${3400+i} and PO-${3500+i}: ${6+i} units arrive 2028-05-${day(i)}; which order does this concern?`, "AMBIGUOUS_PO"),
  "date-relative-only": i => standard(i, `PO-${3600+i}: We expect ${8+i} units next month, but have no confirmed ETA.`, `PO-${3600+i}`, null, 8+i, "quantity_change", 0.45),
  "quantity-unspecified": i => standard(i, `PO-${3700+i}: PO-${3700+i} will arrive 2028-06-${day(i)}; quantity is still being checked.`, `PO-${3700+i}`, `2028-06-${day(i)}`, null, "eta_change"),
};

export function generateDataset(perFamily = 10): { messages: DatasetMessage[]; gold: DatasetGold[] } {
  if (!Number.isInteger(perFamily) || perFamily < 1) throw new Error("perFamily must be a positive integer");
  const splitFor = (familyIndex: number): DatasetSplit => familyIndex < 18 ? "development" : familyIndex < 24 ? "validation" : "holdout";
  const messages: DatasetMessage[] = [];
  const gold: DatasetGold[] = [];
  families.forEach((family, familyIndex) => {
    for (let i = 0; i < perFamily; i++) {
      const id = `sup-${String(familyIndex * perFamily + i + 1).padStart(4, "0")}`;
      const scenario = templates[family]!(i);
      const split = splitFor(familyIndex);
      messages.push({ id, message: scenario.message, templateFamily: family, split });
      gold.push({ id, expected: scenario.expected, ...(scenario.reviewState ? { reviewState: scenario.reviewState } : {}), templateFamily: family, split });
    }
  });
  return { messages, gold };
}

function standard(i: number, message: string, po: string | null, eta: string | null, quantity: number | null, type: SupplierCommitment["type"], confidence = 0.96) {
  return { message, expected: { poReference: po, eta, quantity, type, confidence, evidence: [message] } satisfies SupplierCommitment };
}
function review(_i: number, message: string, reviewState: string) { return { message, expected: null, reviewState }; }
function day(i: number) { return String(i + 1).padStart(2, "0"); }
function word(i: number) { return ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][i - 1] ?? String(i); }
