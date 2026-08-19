import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeSpekoBaseUrl,
  readSpekoConfig,
  SPEKO_DEFAULT_BASE_URL,
  type SpekoPluginConfig,
} from "./config.js";
import {
  fetchSpekoModels,
  selectRoutableStage,
  SPEKO_AUTO_MODEL_ID,
  toOpenClawCost,
  toOpenClawModelRows,
} from "./models.js";
import { resolveSpeechConfig, synthesizeSpeko, type SpekoSpeechProviderConfig } from "./speech.js";
import { transcribeSpeko } from "./transcribe.js";
import { createModelsTool, createRoutingPreviewTool, SPEKO_TOOL_NAMES } from "./tools.js";

const PLUGIN_ID = "speko";
const PROVIDER_ID = PLUGIN_ID;
const DEFAULT_MODEL_REF = `${PROVIDER_ID}/${SPEKO_AUTO_MODEL_ID}`;

/**
 * Static fallback catalog. Used when `/v1/models` is unreachable, so a network
 * blip degrades to "routing still works, the picker is thinner" instead of
 * "the provider vanished".
 */
function buildFallbackProvider(apiKey: string, baseUrl: string): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl,
    apiKey,
    models: [
      {
        id: SPEKO_AUTO_MODEL_ID,
        name: "Speko Auto (benchmark-routed, price varies by pick)",
        reasoning: true,
        input: ["text"],
        cost: toOpenClawCost(null),
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Speko",
  description: "Speko routes every leg of a voice pipeline — LLM, speech and transcription — on measured benchmarks.",
  register(api) {
    const resolveConfig = (): SpekoPluginConfig =>
      (api.pluginConfig as SpekoPluginConfig | undefined) ?? readSpekoConfig(api.config);
    const resolveApiKey = (): string | undefined => resolveConfig().apiKey ?? process.env.SPEKO_API_KEY;

    // ---------------------------------------------------------------- text
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Speko",
      docsPath: "/providers/speko",
      envVars: ["SPEKO_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Speko API key",
          hint: "Router key from the Speko dashboard. One key covers LLM, speech and transcription.",
          optionKey: "spekoApiKey",
          flagName: "--speko-api-key",
          envVar: "SPEKO_API_KEY",
          promptMessage: "Enter your Speko API key",
          defaultModel: DEFAULT_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          noteTitle: "Speko",
          noteMessage:
            "The key carries its own routing policy (language, objective, price ceiling, per-stage chain). " +
            "Set plugins.entries.speko.config to override any of it per request.",
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) return null;
          const config = resolveConfig();
          const baseUrl = normalizeSpekoBaseUrl(config.baseUrl);
          try {
            const rows = await fetchSpekoModels({ apiKey, baseUrl });
            const models = toOpenClawModelRows(rows);
            if (models.length === 0) return { provider: buildFallbackProvider(apiKey, baseUrl) };
            return { provider: { api: "openai-completions", baseUrl, apiKey, models } };
          } catch {
            return { provider: buildFallbackProvider(apiKey, baseUrl) };
          }
        },
      },
      /**
       * The router accepts any routable id, so an id it has never seen still
       * resolves rather than 404ing in the picker.
       */
      resolveDynamicModel: (ctx) => ({
        id: ctx.modelId,
        provider: PROVIDER_ID,
        api: "openai-completions",
        baseUrl: normalizeSpekoBaseUrl(resolveConfig().baseUrl),
        name: ctx.modelId,
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
        cost: toOpenClawCost(null),
      }),
    });

    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["text", "voice"],
      liveCatalog: async (ctx) => {
        const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
        if (!apiKey) return null;
        const config = resolveConfig();
        const rows = await fetchSpekoModels({ apiKey, baseUrl: config.baseUrl });
        return [
          ...selectRoutableStage(rows, "llm").map((row) => ({
            kind: "text" as const,
            provider: PROVIDER_ID,
            model: row.id,
            label: `${row.provider} ${row.model}`,
            source: "live" as const,
          })),
          ...selectRoutableStage(rows, "tts").map((row) => ({
            kind: "voice" as const,
            provider: PROVIDER_ID,
            model: row.id,
            label: `${row.provider} ${row.model}`,
            source: "live" as const,
          })),
        ];
      },
    });

    // -------------------------------------------------------------- speech
    api.registerSpeechProvider({
      id: PROVIDER_ID,
      label: "Speko Speech",
      defaultTimeoutMs: 120_000,
      defaultModel: SPEKO_AUTO_MODEL_ID,
      resolveConfig: (ctx) => resolveSpeechConfig(ctx.cfg) as unknown as Record<string, unknown>,
      isConfigured: ({ providerConfig }) => Boolean((providerConfig as SpekoSpeechProviderConfig).apiKey),
      synthesize: async (req) => {
        const outcome = await synthesizeSpeko({
          text: req.text,
          config: req.providerConfig as unknown as SpekoSpeechProviderConfig,
          timeoutMs: req.timeoutMs,
          overrides: req.providerOverrides as
            | { model?: string; voice?: string; instructions?: string; speed?: number }
            | undefined,
        });
        return {
          audioBuffer: outcome.audioBuffer,
          outputFormat: outcome.outputFormat,
          fileExtension: outcome.fileExtension,
          voiceCompatible: outcome.voiceCompatible,
        };
      },
    });

    // --------------------------------------------------------- transcription
    api.registerMediaUnderstandingProvider({
      id: PROVIDER_ID,
      capabilities: ["audio"],
      defaultModels: { audio: SPEKO_AUTO_MODEL_ID },
      transcribeAudio: async (req) => {
        const config = resolveConfig();
        const result = await transcribeSpeko({
          buffer: req.buffer,
          fileName: req.fileName,
          mime: req.mime,
          apiKey: req.apiKey || resolveApiKey() || "",
          baseUrl: req.baseUrl ?? config.baseUrl,
          model: req.model,
          language: req.language,
          routing: config,
          timeoutMs: req.timeoutMs,
          fetchFn: req.fetchFn,
        });
        return { text: result.text, model: result.model };
      },
    });

    // ---------------------------------------------------------------- tools
    const toolDeps = { resolveApiKey, resolveConfig };
    api.registerTool(createRoutingPreviewTool(toolDeps));
    api.registerTool(createModelsTool(toolDeps));
  },
});

export { SPEKO_DEFAULT_BASE_URL, SPEKO_TOOL_NAMES };
