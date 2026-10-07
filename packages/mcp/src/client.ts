/** Thin HTTP client over the ProcureBrain API. The MCP server stays stateless: all business state, approval checks, and event history remain in the API. */

export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PROCUREBRAIN_API_URL ?? "http://localhost:8787";
  return raw.replace(/\/+$/, "");
}

export class ProcureBrainError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`ProcureBrain API error (${status}): ${detail}`);
  }
}

export type FetchFn = typeof globalThis.fetch;

export interface AnalyzeEmailInput {
  readonly text: string;
  readonly entityId?: string;
}

export interface ApproveEtaInput {
  readonly cacheKey: string;
  readonly eta?: string;
}

export interface BindDocumentInput {
  readonly cacheKey: string;
  readonly entityId: string;
}

export type ImportKind = "purchase-orders" | "supplier-updates" | "receipts" | "followups";

export class ProcureBrainClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(baseUrl: string = apiBaseUrl(), fetchFn: FetchFn = globalThis.fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchFn = fetchFn;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      });
    } catch (error) {
      throw new ProcureBrainError(0, error instanceof Error ? error.message : "Network request failed");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const detail =
        typeof body === "object" && body !== null && "error" in body && typeof (body as { error: unknown }).error === "string"
          ? (body as { error: string }).error
          : response.statusText || "Request failed";
      throw new ProcureBrainError(response.status, detail);
    }
    return body as T;
  }

  health(): Promise<{ ok: boolean; storage: string }> {
    return this.request("/api/health");
  }

  listPurchaseOrders(): Promise<unknown[]> {
    return this.request("/api/purchase-orders");
  }

  getPurchaseOrder(entityId: string): Promise<unknown> {
    return this.request(`/api/purchase-orders/${encodeURIComponent(entityId)}`);
  }

  getTimeline(entityId: string): Promise<unknown[]> {
    return this.request(`/api/purchase-orders/${encodeURIComponent(entityId)}/timeline`);
  }

  listExceptions(): Promise<unknown[]> {
    return this.request("/api/exceptions");
  }

  analyzeSupplierEmail(input: AnalyzeEmailInput): Promise<unknown> {
    return this.request("/api/analysis/supplier-text", {
      method: "POST",
      body: JSON.stringify(input.entityId ? { text: input.text, entityId: input.entityId } : { text: input.text }),
    });
  }

  approveEtaChange(input: ApproveEtaInput): Promise<unknown> {
    return this.request(`/api/analysis/runs/${encodeURIComponent(input.cacheKey)}/approve`, {
      method: "POST",
      body: JSON.stringify(input.eta ? { eta: input.eta } : {}),
    });
  }

  bindDocumentToPo(input: BindDocumentInput): Promise<unknown> {
    return this.request(`/api/analysis/runs/${encodeURIComponent(input.cacheKey)}/bind`, {
      method: "POST",
      body: JSON.stringify({ entityId: input.entityId }),
    });
  }

  importCsv(kind: ImportKind, csv: string): Promise<unknown> {
    return this.fetchJson(`/api/imports/${kind}`, csv, "text/csv");
  }

  private async fetchJson<T>(path: string, body: string, contentType: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
    } catch (error) {
      throw new ProcureBrainError(0, error instanceof Error ? error.message : "Network request failed");
    }
    const parsed = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const detail =
        typeof parsed === "object" && parsed !== null && "error" in parsed && typeof (parsed as { error: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : response.statusText || "Request failed";
      throw new ProcureBrainError(response.status, detail);
    }
    return parsed as T;
  }

  listSources(): Promise<unknown[]> {
    return this.request("/api/sources");
  }

  getSource(id: string): Promise<unknown> {
    return this.request(`/api/sources/${encodeURIComponent(id)}`);
  }

  listAnalysisRuns(): Promise<unknown[]> {
    return this.request("/api/analysis/runs");
  }

  getAnalysisRun(cacheKey: string): Promise<unknown> {
    return this.request(`/api/analysis/runs/${encodeURIComponent(cacheKey)}`);
  }
}
