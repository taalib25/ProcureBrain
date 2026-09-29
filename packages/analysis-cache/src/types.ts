export type AnalysisMediaType = "csv" | "image" | "text" | "json" | "other";
export type AnalysisStatus = "queued" | "running" | "completed" | "failed" | "needs_review";

export interface AnalysisRequest {
  readonly input: string | Uint8Array;
  readonly mediaType: AnalysisMediaType;
  readonly analysisType: string;
  readonly model: string;
  readonly provider: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  /** Any interpretation-affecting caller options or contextual data. */
  readonly options?: Readonly<Record<string, unknown>>;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly estimatedCostUsd?: number;
}

export interface AnalysisRun<TResult = unknown> {
  readonly id: string;
  readonly cacheKey: string;
  readonly inputHash: string;
  readonly request: Omit<AnalysisRequest, "input">;
  readonly status: AnalysisStatus;
  readonly result?: TResult;
  readonly error?: string;
  readonly usage?: TokenUsage;
  readonly modelRequest?: unknown;
  readonly modelResponse?: unknown;
  readonly fallbackTier?: string;
  readonly leaseUntil?: string;
  readonly leaseGeneration?: number;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface ModelAnalysisResult<TResult> {
  readonly result: TResult;
  readonly usage?: TokenUsage;
  readonly status?: Extract<AnalysisStatus, "completed" | "needs_review">;
  readonly modelRequest?: unknown;
  readonly modelResponse?: unknown;
  readonly fallbackTier?: string;
}

export interface AnalysisCache<TResult = unknown> {
  get(cacheKey: string): AnalysisRun<TResult> | undefined;
  set(run: AnalysisRun<TResult>): void;
  delete(cacheKey: string): void;
  values(): readonly AnalysisRun<TResult>[];
  export(): string;
}

export interface DurableAnalysisCache<TResult = unknown> {
  get(cacheKey: string): Promise<AnalysisRun<TResult> | undefined>;
  /** Atomically creates a running claim or returns the current record. */
  claim(run: AnalysisRun<TResult>, leaseMs: number, input: Uint8Array, retryFailed: boolean, ownerToken: string): Promise<{ run: AnalysisRun<TResult>; claimed: boolean; generation?: number }>;
  set(run: AnalysisRun<TResult>, ownerToken: string, generation: number): Promise<boolean>;
  renew?(cacheKey: string, ownerToken: string, generation: number, leaseMs: number): Promise<boolean>;
  /** Waits for another process to finish or its lease to expire. */
  waitForChange(cacheKey: string, pollMs: number): Promise<void>;
}
