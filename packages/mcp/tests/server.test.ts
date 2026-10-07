import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server";
import { ProcureBrainClient } from "../src/client";

function stubClient() {
  const client = new ProcureBrainClient("http://localhost:8787", (async () => new Response("{}", { status: 200 })) as typeof fetch);
  vi.spyOn(client, "listPurchaseOrders").mockResolvedValue([{ entityId: "po-1" }]);
  return client;
}

describe("mcp server", () => {
  it("returns array results wrapped as structured records", async () => {
    const client = stubClient();
    const server = createMcpServer(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    try {
      const result = await mcp.callTool({ name: "list_purchase_orders", arguments: {} });
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as { result: unknown[] }).result).toEqual([{ entityId: "po-1" }]);
    } finally {
      await mcp.close();
      await server.close();
    }
  });
});
