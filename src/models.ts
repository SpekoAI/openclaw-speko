import { normalizeSpekoBaseUrl } from "./config.js";

/** One row of `GET /v1/models`. */
export type SpekoModelRow = {
  id: string;
  model: string;
  provider: string;
  owned_by?: string;
  api: "llm" | "stt" | "tts";
  routable: boolean;
  /**
   * Published benchmark price for the row's own stage:
   * LLM = USD per 1M tokens, STT = USD per minute, TTS = USD per 1M characters.
   * The field name is a historical artifact of the STT unit; it is not
   * per-minute for LLM or TTS rows. `null` when the vendor has no published price.
   */
  costPerMinUsd: number | null;
  /** Measured quality on the stage's own scale: LLM score, STT % WER, TTS Elo. */
  quality: number | null;
  qualityUnit?: string | null;
  /** Measured first-token / first-sample latency in milliseconds. */
  latencyMs: number | null;
  languages: string[];
  aliases?: string[];
  voices?: string[];
};

export type SpekoStage = "llm" | "stt" | "tts";

export async function fetchSpekoModels(params: {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<SpekoModelRow[]> {
  const base = normalizeSpekoBaseUrl(params.baseUrl);
  const doFetch = params.fetchFn ?? fetch;
  const response = await doFetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${params.apiKey}` },
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`Speko GET /v1/models failed: ${response.status} ${await readSnippet(response)}`);
  }
  const payload = (await response.json()) as { data?: unknown };
  return Array.isArray(payload.data) ? (payload.data as SpekoModelRow[]) : [];
}

async function readSnippet(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "";
  }
}

export function selectRoutableStage(rows: SpekoModelRow[], stage: SpekoStage): SpekoModelRow[] {
  return rows.filter((row) => row.api === stage && row.routable);
}

/**
 * The synthetic model id that hands routing to the router's own benchmark
 * ranking instead of pinning a vendor. This is the id the plugin defaults to.
 */
export const SPEKO_AUTO_MODEL_ID = "auto";

export type OpenClawModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type OpenClawModelRow = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ["text"];
  contextWindow: number;
  maxTokens: number;
  cost: OpenClawModelCost;
  compat: { supportsStore: false };
};

/**
 * The router validates the request body strictly and rejects OpenAI's `store`
 * property outright:
 *
 *   400 {"message":"store: property 'store' is unsupported",
 *        "code":"wrong_api_format"}
 *
 * OpenClaw's OpenAI client sends `store: false` on every chat turn, so without
 * this flag every routed turn fails. Declared per model because that is where
 * OpenClaw reads compat from.
 */
const SPEKO_COMPAT = { supportsStore: false } as const;

/**
 * OpenClaw requires a four-way cost breakdown. Speko publishes one blended
 * USD/1M-token figure per model, so every side carries the same number, and a
 * model with no published price reports zero rather than a guess. The model
 * label says so where a reader would otherwise read zero as free.
 */
export function toOpenClawCost(price: number | null): OpenClawModelCost {
  const value = typeof price === "number" ? price : 0;
  return { input: value, output: value, cacheRead: value, cacheWrite: value };
}

/**
 * Conservative context defaults. The router accepts any routable id and holds
 * the real per-vendor window itself; `/v1/models` does not publish one, so
 * advertising a large window here would be a guess presented as a fact.
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

export function toOpenClawModelRows(rows: SpekoModelRow[]): OpenClawModelRow[] {
  const llm = selectRoutableStage(rows, "llm");
  const auto: OpenClawModelRow = {
    id: SPEKO_AUTO_MODEL_ID,
    name: "Speko Auto (benchmark-routed, price varies by pick)",
    reasoning: true,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    cost: toOpenClawCost(null),
    compat: SPEKO_COMPAT,
  };
  const pinned = llm.map((row) => ({
    id: row.id,
    name:
      row.costPerMinUsd === null
        ? `${row.provider} ${row.model} (no published price)`
        : `${row.provider} ${row.model}`,
    reasoning: true,
    input: ["text"] as ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    cost: toOpenClawCost(row.costPerMinUsd),
    compat: SPEKO_COMPAT,
  }));
  return [auto, ...pinned];
}
