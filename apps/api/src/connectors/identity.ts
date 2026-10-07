import type { Supplier } from "../store";

export const emailAddress = (value: string) => (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
export const phoneNumber = (value: string) => value.replace(/[^0-9]/g, "");
/** Exact contacts win. Shared domains/phone numbers must never silently pick one supplier. */
export function supplierForSender(suppliers: Supplier[], sender: string | null, channel: string): Supplier | undefined {
  if (!sender) return undefined;
  const active = suppliers.filter(supplier => supplier.status === "active");
  const exact = channel === "whatsapp" || channel === "supplier_sms"
    ? active.filter(supplier => supplier.phone && phoneNumber(supplier.phone) === phoneNumber(sender))
    : active.filter(supplier => supplier.primaryEmail && emailAddress(supplier.primaryEmail) === emailAddress(sender));
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  if (!sender.includes("@")) return undefined;
  const domain = emailAddress(sender).split("@")[1];
  const generic = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "live.com"]);
  if (!domain || generic.has(domain)) return undefined;
  const matches = active.filter(supplier => supplier.emailDomain?.toLowerCase() === domain);
  return matches.length === 1 ? matches[0] : undefined;
}
