import type { ExtractionAdapter } from "./adapter";
import type { PoContextRecord } from "./context";
import { OpenAIExtractionAdapter } from "./openai";
import { OpenRouterExtractionAdapter, type OpenRouterResult, type OpenRouterUsage } from "./openrouter";

export type AIProvider = "openai" | "openrouter";
export type ConfiguredAIEnv = Readonly<Record<string, string | undefined>>;

export interface SafeProviderResponse {
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null; readonly totalTokens: number | null } | null;
  readonly response: OpenRouterResult["response"] | null;
}

export interface ConfiguredAIProvider {
  readonly provider: AIProvider;
  readonly model: string;
  readonly configured: boolean;
  readonly configurationError: string | null;
  readonly extractionAdapter?: ExtractionAdapter & { readonly lastResponse: SafeProviderResponse | null };
  readonly visionAdapter?: {
    extract(image: Uint8Array, mimeType: string): Promise<{
      output: unknown;
      usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
      response: OpenRouterResult["response"];
    }>;
  };
}

const safeUsage = (usage: OpenRouterUsage) => ({
  inputTokens: usage.promptTokens,
  outputTokens: usage.completionTokens,
  totalTokens: usage.totalTokens,
});

/** Selects a configured provider without failing application startup when credentials are absent. */
export function createConfiguredAIProvider(env: ConfiguredAIEnv = process.env): ConfiguredAIProvider {
  const requested = env.AI_PROVIDER?.toLowerCase();
  const provider: AIProvider = requested === "openai" || requested === "openrouter"
    ? requested
    : env.OPENROUTER_API_KEY ? "openrouter" : "openai";

  if (provider === "openrouter") {
    const model = env.OPENROUTER_MODEL || "~z-ai/glm-flash-latest";
    if (!env.OPENROUTER_API_KEY) {
      return { provider, model, configured: false, configurationError: "OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter" };
    }
    const adapter = new OpenRouterExtractionAdapter({ apiKey: env.OPENROUTER_API_KEY, model });
    let lastResponse: SafeProviderResponse | null = null;
    const extractionAdapter = {
      extract: async (message: string, poContext: readonly PoContextRecord[] = []) => {
        lastResponse = null;
        const result = await adapter.extractWithResponse(message, poContext);
        lastResponse = { usage: safeUsage(result.usage), response: result.response };
        return result.output;
      },
      get lastResponse() { return lastResponse; },
    };
    return {
      provider, model, configured: true, configurationError: null, extractionAdapter,
      visionAdapter: {
        extract: async (image: Uint8Array, mimeType: string) => {
          const result = await adapter.extractWithResponse([
            { type: "text", text: "Extract a supplier commitment from this image." },
            { type: "image_url", image_url: { url: imageDataUri(image, mimeType) } },
          ]);
          lastResponse = { usage: safeUsage(result.usage), response: result.response };
          return { output: result.output, usage: safeUsage(result.usage), response: result.response };
        },
      },
    };
  }

  const model = env.OPENAI_MODEL || "gpt-4o-mini";
  if (!env.OPENAI_API_KEY) {
    return { provider, model, configured: false, configurationError: "OPENAI_API_KEY is required when AI_PROVIDER=openai" };
  }
  let lastResponse: SafeProviderResponse | null = null;
  const adapter = new OpenAIExtractionAdapter({
    apiKey: env.OPENAI_API_KEY,
    model,
    fetch: async (input, init) => {
      const response = await globalThis.fetch(input, init);
      try {
        const body = await response.clone().json() as {
          id?: unknown; model?: unknown; choices?: Array<{ finish_reason?: unknown }>;
          usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
        };
        const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
        lastResponse = {
          usage: body.usage ? { inputTokens: num(body.usage.prompt_tokens), outputTokens: num(body.usage.completion_tokens), totalTokens: num(body.usage.total_tokens) } : null,
          response: { id: typeof body.id === "string" ? body.id : null, model: typeof body.model === "string" ? body.model : null, finishReason: typeof body.choices?.[0]?.finish_reason === "string" ? body.choices[0].finish_reason : null },
        };
      } catch { lastResponse = null; }
      return response;
    },
  });
  const extractionAdapter = {
    extract: (message: string, poContext: readonly PoContextRecord[] = []) => adapter.extract(message, poContext),
    get lastResponse() { return lastResponse; },
  };
  return { provider, model, configured: true, configurationError: null, extractionAdapter };
}

function imageDataUri(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mimeType};base64,${btoa(binary)}`;
}
