import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeSpekoBaseUrl, SPEKO_DEFAULT_LANGUAGE, type SpekoPluginConfig } from "./config.js";
import { fetchSpekoModels, selectRoutableStage, type SpekoStage } from "./models.js";

const STAGE_VALUES: SpekoStage[] = ["llm", "stt", "tts"];

/** One candidate the router considered but did not pick. */
type RunnerUp = { id: string; model: string; provider: string; score: number; measuredLanguage?: boolean };

type RoutingPreview = {
  id: string;
  model: string;
  provider: string;
  language: string;
  language_recognized: boolean;
  objective: string;
  reason: string;
  /** "measured" when the decision came from benchmark data rather than a fallback. */
  evidence: string;
  /** Date window the benchmark readings were taken in. */
  measured?: string;
  runners_up?: RunnerUp[];
};

type SpekoToolDeps = {
  resolveApiKey: () => string | undefined;
  resolveConfig: () => SpekoPluginConfig;
  fetchFn?: typeof fetch;
};

function textResult<T>(text: string, details: T) {
  return { content: [{ type: "text" as const, text }], details };
}

function requireApiKey(deps: SpekoToolDeps): string {
  const apiKey = deps.resolveApiKey();
  if (!apiKey) {
    throw new Error("Speko is not configured: set SPEKO_API_KEY or plugins.entries.speko.config.apiKey");
  }
  return apiKey;
}

/**
 * `GET /v1/routing/preview` — resolves a route without sending any upstream
 * traffic and without spending anything. This is what makes Speko's routing
 * inspectable instead of a black box: the agent can state which vendor it is
 * about to use, on what measured evidence, and what it passed over.
 */
export function createRoutingPreviewTool(deps: SpekoToolDeps): AnyAgentTool {
  return {
    name: "speko_routing_preview",
    label: "Speko Routing Preview",
    description:
      "Dry-run Speko's routing decision for one pipeline stage (llm, stt or tts) without spending anything. " +
      "Returns the model the router would dial, why, the benchmark window the decision rests on, and the runners-up. " +
      "Use this before a voice or transcription task when the user asks which model will be used, or to check that a " +
      "language, objective or price ceiling produces the stack they want.",
    parameters: Type.Object({
      stage: Type.Union(
        STAGE_VALUES.map((stage) => Type.Literal(stage)),
        { description: "Which pipeline stage to resolve: llm, stt or tts." },
      ),
      language: Type.Optional(Type.String({ description: "BCP 47 language tag, for example en, es-MX or hi." })),
      objective: Type.Optional(
        Type.Union([Type.Literal("latency"), Type.Literal("cost"), Type.Literal("quality"), Type.Literal("balanced")], {
          description: "Which measured axis wins when candidates tie.",
        }),
      ),
      allow: Type.Optional(
        Type.String({ description: "Comma-separated provider:model ids to restrict the candidate set to." }),
      ),
      deny: Type.Optional(Type.String({ description: "Comma-separated provider:model ids to exclude." })),
      max_price: Type.Optional(
        Type.Number({
          description:
            "Price ceiling in the stage's own unit: STT USD/minute, LLM USD/1M tokens, TTS USD/1M characters.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const apiKey = requireApiKey(deps);
      const config = deps.resolveConfig();
      const args = params as {
        stage: SpekoStage;
        language?: string;
        objective?: string;
        allow?: string;
        deny?: string;
        max_price?: number;
      };
      const query = new URLSearchParams({ stage: args.stage });
      const language = args.language ?? config.language ?? SPEKO_DEFAULT_LANGUAGE;
      if (language) query.set("language", language);
      const objective = args.objective ?? config.objective;
      if (objective) query.set("objective", objective);
      const allow = args.allow ?? config.allow?.join(",");
      if (allow) query.set("allow", allow);
      const deny = args.deny ?? config.deny?.join(",");
      if (deny) query.set("deny", deny);
      const maxPrice = args.max_price ?? config.maxPrice;
      if (typeof maxPrice === "number") query.set("max_price", String(maxPrice));

      const doFetch = deps.fetchFn ?? fetch;
      const response = await doFetch(`${normalizeSpekoBaseUrl(config.baseUrl)}/routing/preview?${query.toString()}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      if (!response.ok) {
        throw new Error(`Speko routing preview failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
      }
      const preview = (await response.json()) as RoutingPreview;
      return textResult(formatPreview(args.stage, preview), preview);
    },
  };
}

function formatPreview(stage: SpekoStage, preview: RoutingPreview): string {
  const lines = [
    `${stage.toUpperCase()} route: ${preview.provider} ${preview.model} (${preview.id})`,
    `reason: ${preview.reason} | objective: ${preview.objective} | evidence: ${preview.evidence}`,
    `language: ${preview.language}${preview.language_recognized ? " (measured)" : " (not measured for this language)"}`,
  ];
  if (preview.measured) lines.push(`benchmark window: ${preview.measured}`);
  const runnersUp = preview.runners_up ?? [];
  if (runnersUp.length > 0) {
    const listed = runnersUp
      .slice(0, 3)
      .map((row) => `${row.provider} ${row.model} (${row.score.toFixed(3)})`)
      .join(", ");
    lines.push(`passed over: ${listed}`);
  }
  return lines.join("\n");
}

/**
 * `GET /v1/models` filtered to one stage. Only rows with `routable: true` can be
 * selected or pinned, so this is the only correct source of pin ids.
 */
export function createModelsTool(deps: SpekoToolDeps): AnyAgentTool {
  return {
    name: "speko_models",
    label: "Speko Models",
    description:
      "List the Speko models that can be routed to or pinned, for one pipeline stage (llm, stt or tts), with their " +
      "measured latency, measured quality, published price and supported languages. Use this to answer which models " +
      "are available, to compare vendors on measured numbers, or to find the exact id to pin.",
    parameters: Type.Object({
      stage: Type.Union(
        STAGE_VALUES.map((stage) => Type.Literal(stage)),
        { description: "Which pipeline stage to list: llm, stt or tts." },
      ),
      language: Type.Optional(Type.String({ description: "Only list models measured for this BCP 47 language." })),
    }),
    async execute(_toolCallId, params, signal) {
      const apiKey = requireApiKey(deps);
      const config = deps.resolveConfig();
      const args = params as { stage: SpekoStage; language?: string };
      const rows = await fetchSpekoModels({
        apiKey,
        baseUrl: config.baseUrl,
        fetchFn: deps.fetchFn,
        signal,
      });
      let stageRows = selectRoutableStage(rows, args.stage);
      if (args.language) {
        const wanted = args.language.split("-")[0]!.toLowerCase();
        stageRows = stageRows.filter((row) => row.languages.some((lang) => lang.toLowerCase().startsWith(wanted)));
      }
      const unit = priceUnit(args.stage);
      const lines = stageRows.map((row) => {
        const price = row.costPerMinUsd === null ? "no published price" : `$${row.costPerMinUsd} ${unit}`;
        const quality = row.quality === null ? "unmeasured" : `${row.quality}${row.qualityUnit ?? ""}`;
        const latency = row.latencyMs === null ? "unmeasured" : `${row.latencyMs}ms`;
        return `${row.id} — ${row.provider} ${row.model} | quality ${quality} | latency ${latency} | ${price} | languages ${row.languages.join(",") || "none measured"}`;
      });
      const header = `${stageRows.length} routable ${args.stage} models${args.language ? ` measured for ${args.language}` : ""}`;
      return textResult([header, ...lines].join("\n"), { stage: args.stage, models: stageRows });
    },
  };
}

function priceUnit(stage: SpekoStage): string {
  if (stage === "llm") return "per 1M tokens";
  if (stage === "tts") return "per 1M characters";
  return "per minute";
}

export const SPEKO_TOOL_NAMES = ["speko_routing_preview", "speko_models"] as const;
