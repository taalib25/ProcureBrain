import { describe, expect, it, vi } from "vitest";
import { ProcureBrainClient, ProcureBrainError, apiBaseUrl } from "../src/client";

function mockFetch(body: unknown, status = 200, statusText = "OK") {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, statusText, headers: { "content-type": "application/json" } }));
}

describe("mcp client", () => {
  it("defaults to the local API and trims trailing slashes", () => {
    expect(apiBaseUrl({} as NodeJS.ProcessEnv)).toBe("http://localhost:8787");
    expect(apiBaseUrl({ PROCUREBRAIN_API_URL: "http://example:9000///" } as NodeJS.ProcessEnv)).toBe("http://example:9000");
  });

  it("analyzes an email without entityId for paste-first matching", async () => {
    const fetchFn = mockFetch({ proposal: {}, poCandidates: [] });
    const client = new ProcureBrainClient("http://localhost:8787", fetchFn as typeof fetch);
    await client.analyzeSupplierEmail({ text: "PO-1001 delayed" });
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/api/analysis/supplier-text");
    expect(JSON.parse(String(init.body))).toEqual({ text: "PO-1001 delayed" });
  });

  it("includes entityId and eta only when provided", async () => {
    const fetchFn = mockFetch({ proposal: {} });
    const client = new ProcureBrainClient("http://localhost:8787", fetchFn as typeof fetch);
    await client.analyzeSupplierEmail({ text: "delay", entityId: "po-1" });
    expect(JSON.parse(String((fetchFn.mock.calls[0]! as unknown as [string, RequestInit])[1].body))).toEqual({ text: "delay", entityId: "po-1" });

    const approveFetch = mockFetch({ status: "applied" });
    const approveClient = new ProcureBrainClient("http://localhost:8787", approveFetch as typeof fetch);
    await approveClient.approveEtaChange({ cacheKey: "abc", eta: "2026-11-10" });
    const [approveUrl, approveInit] = approveFetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(approveUrl).toBe("http://localhost:8787/api/analysis/runs/abc/approve");
    expect(JSON.parse(String(approveInit.body))).toEqual({ eta: "2026-11-10" });
  });

  it("posts CSV imports as text/csv", async () => {    const fetchFn = mockFetch({ inserted: 1 });
    const client = new ProcureBrainClient("http://localhost:8787", fetchFn as typeof fetch);
    await client.importCsv("purchase-orders", "po,eta\nPO-1,2026-01-01");
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/api/imports/purchase-orders");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("text/csv");
  });

  it("throws ProcureBrainError with API detail on failure", async () => {
    const fetchFn = mockFetch({ error: "Selected purchase order was not found" }, 404, "Not Found");
    const client = new ProcureBrainClient("http://localhost:8787", fetchFn as typeof fetch);
    await expect(client.getPurchaseOrder("missing")).rejects.toMatchObject({ status: 404 });
    try {
      await client.getPurchaseOrder("missing");
    } catch (error) {
      expect(error).toBeInstanceOf(ProcureBrainError);
      expect((error as Error).message).toContain("Selected purchase order was not found");
    }
  });

  it("binds a document run to a purchase order", async () => {
    const fetchFn = mockFetch({ proposal: { state: "VALID" } });
    const client = new ProcureBrainClient("http://localhost:8787", fetchFn as typeof fetch);
    await client.bindDocumentToPo({ cacheKey: "doc-key", entityId: "po-1" });
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/api/analysis/runs/doc-key/bind");
    expect(JSON.parse(String(init.body))).toEqual({ entityId: "po-1" });
  });

  it("creates the MCP server without connecting a transport", async () => {
    const { createMcpServer } = await import("../src/server");
    expect(() => createMcpServer(new ProcureBrainClient("http://localhost:8787", mockFetch({}) as typeof fetch))).not.toThrow();
  });
});
