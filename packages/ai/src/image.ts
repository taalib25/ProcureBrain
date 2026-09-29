import { SupplierCommitmentSchema, type SupplierCommitment } from "./schema";
import type { ExtractionAdapter } from "./adapter";
import { runCachedAnalysis, type AnalysisCache, type AnalysisRun } from "../../analysis-cache/src";

export interface ImageExtractionOptions {
  readonly vision: ExtractionAdapter;
  readonly ocr: ExtractionAdapter;
  readonly lowConfidenceThreshold?: number;
}

export interface ImageExtractionResult {
  readonly commitment: SupplierCommitment | null;
  readonly tier: "vision" | "ocr" | "review";
  readonly reviewRequired: boolean;
  readonly reason: string | null;
}

export interface CachedImageExtractionOptions extends ImageExtractionOptions {
  readonly cache: AnalysisCache<ImageExtractionResult>;
  readonly model: string;
  readonly provider: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
}

/** Vision is primary. OCR is a fallback only when vision fails validation or confidence is low. */
export async function extractSupplierCommitmentFromImage(
  image: string | Uint8Array,
  options: ImageExtractionOptions,
): Promise<ImageExtractionResult> {
  const threshold = options.lowConfidenceThreshold ?? 0.7;
  let visionFailure = "Vision provider failed";
  try {
    const result = SupplierCommitmentSchema.safeParse(await options.vision.extract(imageInput(image)));
    if (result.success && result.data.confidence >= threshold) {
      return { commitment: result.data, tier: "vision", reviewRequired: false, reason: null };
    }
    visionFailure = result.success ? "Vision confidence below threshold" : "Vision output did not match schema";
  } catch {
    // Provider errors deliberately trigger the OCR tier.
  }

  try {
    const result = SupplierCommitmentSchema.safeParse(await options.ocr.extract(imageInput(image)));
    if (result.success && result.data.confidence >= threshold) {
      return { commitment: result.data, tier: "ocr", reviewRequired: false, reason: null };
    }
    return { commitment: result.success ? result.data : null, tier: "review", reviewRequired: true,
      reason: result.success ? "OCR confidence below threshold" : "OCR output did not match schema" };
  } catch {
    return { commitment: null, tier: "review", reviewRequired: true, reason: `${visionFailure}; OCR provider failed` };
  }
}

/** Versioned image-analysis cache; successful, OCR-fallback, and review outcomes are replayable. */
export async function extractCachedSupplierCommitmentFromImage(
  image: string | Uint8Array,
  options: CachedImageExtractionOptions,
  context: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly result: ImageExtractionResult; readonly run: AnalysisRun<ImageExtractionResult>; readonly cacheHit: boolean }> {
  const input = typeof image === "string" ? image : image;
  const cached = await runCachedAnalysis({
    input: JSON.stringify({ image: typeof input === "string" ? input : Array.from(input), context }),
    mediaType: "image",
    analysisType: "supplier_commitment_image_extraction",
    model: options.model,
    provider: options.provider,
    promptVersion: options.promptVersion,
    schemaVersion: options.schemaVersion,
  }, options.cache, { run: async () => ({ result: await extractSupplierCommitmentFromImage(image, options) }) });
  return { result: cached.run.result ?? { commitment: null, tier: "review", reviewRequired: true, reason: cached.run.error ?? "Cached image analysis has no result" }, run: cached.run, cacheHit: cached.cacheHit };
}

function imageInput(image: string | Uint8Array): string {
  if (typeof image === "string") return image;
  let binary = "";
  for (const byte of image) binary += String.fromCharCode(byte);
  return `data:application/octet-stream;base64,${btoa(binary)}`;
}
