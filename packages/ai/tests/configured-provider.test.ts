import { describe, expect, it } from "vitest";
import { createConfiguredAIProvider } from "../src/configured-provider";

describe("createConfiguredAIProvider", () => {
  it("selects OpenRouter automatically when its key is present", () => {
    const configured = createConfiguredAIProvider({ OPENROUTER_API_KEY: "secret-value" });
    expect(configured).toMatchObject({ provider: "openrouter", model: "~z-ai/glm-flash-latest", configured: true });
    expect(configured.extractionAdapter).toBeDefined();
    expect(configured.visionAdapter).toBeDefined();
    expect(JSON.stringify(configured)).not.toContain("secret-value");
  });

  it("honors explicit OpenRouter provider and model", () => {
    const configured = createConfiguredAIProvider({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "secret-value", OPENROUTER_MODEL: "custom/model" });
    expect(configured).toMatchObject({ provider: "openrouter", model: "custom/model", configured: true });
  });

  it("reports missing OpenRouter credentials without throwing", () => {
    expect(() => createConfiguredAIProvider({ AI_PROVIDER: "openrouter" })).not.toThrow();
    expect(createConfiguredAIProvider({ AI_PROVIDER: "openrouter" })).toMatchObject({
      provider: "openrouter", configured: false,
      configurationError: "OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter",
    });
  });

  it("preserves explicitly selected OpenAI fallback", () => {
    expect(createConfiguredAIProvider({ AI_PROVIDER: "openai", OPENAI_API_KEY: "openai-secret", OPENAI_MODEL: "gpt-test" }))
      .toMatchObject({ provider: "openai", model: "gpt-test", configured: true });
    expect(createConfiguredAIProvider({ AI_PROVIDER: "openai" })).toMatchObject({
      provider: "openai", configured: false,
      configurationError: "OPENAI_API_KEY is required when AI_PROVIDER=openai",
    });
  });

  it("uses the OpenAI model default", () => {
    expect(createConfiguredAIProvider({ AI_PROVIDER: "openai", OPENAI_API_KEY: "secret" }).model).toBe("gpt-4o-mini");
  });
});
