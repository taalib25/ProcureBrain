import { describe, expect, it } from "vitest";
import {
  documentSourceTypeForMime,
  isDocumentSource,
  isRemoteChannelSource,
  isSourceType,
  normalizeWhatsAppPayload,
  validateSourceProvenance,
} from "../src/sources";

describe("source taxonomy and provenance", () => {
  it("accepts every source type the system writes today", () => {
    for (const known of ["purchase_orders", "supplier_updates", "receipts", "followups", "csv", "supplier_message", "supplier_email", "supplier_sms", "whatsapp", "supplier_image", "supplier_pdf"]) {
      expect(isSourceType(known)).toBe(true);
    }
    expect(isSourceType("carrier_pigeon")).toBe(false);
  });

  it("requires sender, message id, and received time for remote channels", () => {
    expect(isRemoteChannelSource("whatsapp")).toBe(true);
    expect(isRemoteChannelSource("supplier_email")).toBe(true);
    expect(isRemoteChannelSource("supplier_message")).toBe(false);
    expect(validateSourceProvenance("bogus", {})).toHaveLength(1);
    expect(validateSourceProvenance("supplier_message", undefined)).toEqual([]);
    expect(validateSourceProvenance("whatsapp", undefined)).not.toEqual([]);
    expect(validateSourceProvenance("whatsapp", { sender: "+1555", channelMessageId: "wamid.1", receivedAt: "2026-09-01T10:00:00Z" })).toEqual([]);
    expect(validateSourceProvenance("supplier_email", { sender: "a@b.co" })).toHaveLength(2);
    expect(validateSourceProvenance("supplier_email", { sender: "a@b.co", channelMessageId: "m1", receivedAt: "not-a-date" })).toHaveLength(1);
  });

  it("maps document mime types to document source types", () => {
    expect(documentSourceTypeForMime("application/pdf")).toBe("supplier_pdf");
    expect(documentSourceTypeForMime("image/png")).toBe("supplier_image");
    expect(isDocumentSource("supplier_pdf")).toBe(true);
    expect(isDocumentSource("whatsapp")).toBe(false);
  });

  it("normalizes a WhatsApp payload into claim text plus provenance", () => {
    const claim = normalizeWhatsAppPayload({ from: "+15550123456", messageId: "wamid.abc", timestamp: 1756720800, text: "  PO-1001 moved to 2026-11-10  " });
    expect(claim).toMatchObject({
      claimText: "PO-1001 moved to 2026-11-10",
      provenance: { sender: "+15550123456", channelMessageId: "wamid.abc", receivedAt: "2025-09-01T10:00:00.000Z" },
    });
    expect(validateSourceProvenance("whatsapp", claim!.provenance)).toEqual([]);
    expect(normalizeWhatsAppPayload({ from: "+1555", text: "no id" })).toBeNull();
    expect(normalizeWhatsAppPayload({ from: "", messageId: "x", text: "hi" })).toBeNull();
  });
});
