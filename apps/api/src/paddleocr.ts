import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface OcrBlock {
  readonly text: string;
  readonly label: string | null;
  readonly bbox: readonly number[] | null;
  readonly confidence: number | null;
}

export interface OcrPage {
  readonly pageIndex: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly text: string;
  readonly confidence: number;
  readonly blocks: readonly OcrBlock[];
}

export interface OcrDocument {
  readonly text: string;
  readonly confidence: number;
  readonly pages: readonly OcrPage[];
}

export interface PaddleOcrAdapter {
  extract(bytes: Uint8Array, mimeType: string): Promise<OcrDocument>;
  close(): Promise<void>;
}

interface WorkerResponse {
  readonly requestId?: string;
  readonly error?: string;
  readonly text?: string;
  readonly confidence?: number;
  readonly pages?: OcrPage[];
}

interface PendingRequest {
  readonly resolve: (result: OcrDocument) => void;
  readonly reject: (error: Error) => void;
}

export interface PaddleOcrAdapterOptions {
  readonly pythonExecutable?: string;
  readonly workerPath?: string;
}

/**
 * Reuses one local PaddleOCR process so model weights are loaded once. Requests
 * are sent over a private stdin/stdout JSON-lines channel, never a network port.
 */
export class LocalPaddleOcrAdapter implements PaddleOcrAdapter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private closed = false;

  constructor(private readonly options: PaddleOcrAdapterOptions = {}) {}

  extract(bytes: Uint8Array, mimeType: string): Promise<OcrDocument> {
    if (this.closed) return Promise.reject(new Error("PaddleOCR adapter is closed"));
    const requestId = `ocr-${++this.sequence}`;
    const child = this.ensureWorker();
    return new Promise<OcrDocument>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const payload = JSON.stringify({
        requestId,
        mimeType,
        bytesBase64: Buffer.from(bytes).toString("base64"),
      });
      child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        this.pending.delete(requestId);
        reject(new Error(`PaddleOCR worker input failed: ${error.message}`));
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    this.child = null;
    for (const [requestId, request] of this.pending) {
      request.reject(new Error("PaddleOCR worker stopped"));
      this.pending.delete(requestId);
    }
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.kill();
    });
  }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const python = this.options.pythonExecutable ?? process.env.PADDLEOCR_PYTHON ?? "python3";
    const worker = this.options.workerPath ?? fileURLToPath(new URL("../document-ocr/worker.py", import.meta.url));
    const child = spawn(python, ["-u", worker], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleResponse(line));
    child.stderr.on("data", () => {
      // Keep stderr drained: PaddleX emits model/runtime diagnostics here.
    });
    child.on("error", (cause) => {
      if (this.child === child) this.child = null;
      this.rejectPending(new Error(`Unable to start PaddleOCR worker (${cause.message})`));
    });
    child.on("close", (code) => {
      if (this.child === child) this.child = null;
      if (this.pending.size > 0) {
        this.rejectPending(new Error(`PaddleOCR worker exited unexpectedly (${code ?? "signal"})`));
      }
    });
    return child;
  }

  private handleResponse(line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch {
      this.rejectPending(new Error("PaddleOCR worker returned malformed JSON"));
      this.child?.kill();
      return;
    }
    if (!response.requestId) return;
    const request = this.pending.get(response.requestId);
    if (!request) return;
    this.pending.delete(response.requestId);
    if (response.error) {
      request.reject(new Error(response.error));
      return;
    }
    if (typeof response.text !== "string" || !Array.isArray(response.pages)) {
      request.reject(new Error("PaddleOCR worker returned an incomplete result"));
      return;
    }
    request.resolve({
      text: response.text,
      confidence: typeof response.confidence === "number" ? response.confidence : 0,
      pages: response.pages,
    });
  }

  private rejectPending(error: Error): void {
    for (const [requestId, request] of this.pending) {
      request.reject(error);
      this.pending.delete(requestId);
    }
  }
}

export const createPaddleOcrAdapter = (options?: PaddleOcrAdapterOptions): PaddleOcrAdapter =>
  new LocalPaddleOcrAdapter(options);
