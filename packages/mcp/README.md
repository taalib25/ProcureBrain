# ProcureBrain MCP connector

A Model Context Protocol (MCP) stdio server that exposes the ProcureBrain workflow to MCP clients. It is a thin connector: all business state, approval checks, review gates, and event history stay in `apps/api`. The MCP layer only forwards tool calls over HTTP.

## Tools

| Tool | What it does |
| --- | --- |
| `list_purchase_orders` | Current POs with supplier, quantities, ETA, status |
| `get_purchase_order` | Replayed state of one PO (`entityId`) |
| `get_po_timeline` | Immutable event timeline + source evidence for one PO |
| `list_exceptions` | Deterministic attention queue (late, ETA change, shortfall, overdue follow-up) |
| `analyze_supplier_email` | Paste supplier email (`text`, optional `entityId`). Paste-first: omitting `entityId` returns `poCandidates`; re-run with the selected `entityId` for a baseline-grounded proposal. Proposal-only. |
| `bind_document_to_po` | Bind an invoice/image analysis (`cacheKey`) to a PO (`entityId`). Deterministic, no model call. Returns a proposal plus a new `cacheKey` for `approve_eta_change`. |
| `approve_eta_change` | Explicit human approval (`cacheKey`, optional edited `eta` YYYY-MM-DD). Writes the PO event; fails 409 on stale revision or PO mismatch. |
| `import_po_csv` | Deterministic CSV import (`kind` + `csv`). No model calls. |
| `list_sources` / `get_source` | Retained source evidence |
| `list_analysis_runs` / `get_analysis_run` | Cached runs with status, tier, token usage |

`AI proposes; software verifies and commits` holds here too: `analyze_supplier_email` never mutates state, and `approve_eta_change` runs the same revision, PO-match, and date checks as the web flow.

## Run

Start the API first, then the MCP server in another terminal:

```bash
pnpm --filter @procurebrain/api dev
PROCUREBRAIN_API_URL=http://localhost:8787 pnpm --filter @procurebrain/mcp start
```

`PROCUREBRAIN_API_URL` defaults to `http://localhost:8787`. The API needs its own provider credentials for extraction; see `apps/api/README.md`.

## Use from opencode

The project `opencode.json` already registers this server, so a fresh session
picks up all tools after a restart:

```json
{
  "mcp": {
    "procurebrain": {
      "type": "local",
      "command": ["pnpm", "--filter", "@procurebrain/mcp", "start"],
      "environment": { "PROCUREBRAIN_API_URL": "http://localhost:8787" }
    }
  }
}
```

Start the API first (`pnpm --filter @procurebrain/api dev`), then restart
opencode. The CLI workflow is discover → inspect → execute: list tools,
read a tool's input schema, then call it — e.g. `list_purchase_orders` with
`{}`, `analyze_supplier_email` with pasted email text, `approve_eta_change`
with the returned `cacheKey`.

## Inspector

```bash
npx @modelcontextprotocol/inspector --cli pnpm --filter @procurebrain/mcp start
```

Example MCP loop:

```text
analyze_supplier_email { text: "Subject: delay\n\nHi, PO-1001 will now arrive 2026-11-10." }
→ poCandidates: [{ entityId: "po-1", poNumber: "PO-1001" }], proposal.state: VALID
analyze_supplier_email { text: <same email>, entityId: "po-1" }
→ baseline: { poReference: "PO-1001", eta: <current> }, cacheKey: <key>
approve_eta_change { cacheKey: <key> }
→ status: applied, event + updated purchase order
```

## Development

```bash
pnpm --filter @procurebrain/mcp typecheck
pnpm --filter @procurebrain/mcp test
pnpm --filter @procurebrain/mcp build
```

Client tests use mocked fetch; the server test connects over an in-memory transport with a stubbed API client.
