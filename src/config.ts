/**
 * Speko routing configuration.
 *
 * Every field maps to a router request header documented at
 * https://docs.speko.ai/router. A request header always beats the policy baked
 * into the API key, so an unset field here means "use the key's policy".
 */
export type SpekoRoutingObjective = "latency" | "cost" | "quality" | "balanced";

export type SpekoPluginConfig = {
  apiKey?: string;
  baseUrl?: string;
  /** BCP 47. Drives benchmark selection and the vendor's own language setting. */
  language?: string;
  /** Which measured axis wins when candidates tie. */
  objective?: SpekoRoutingObjective;
  /** Candidate allow-list. Entries must be `provider:model`; bare provider names match nothing. */
  allow?: string[];
  /** Candidate deny-list. Unlike `allow` it does not clear the key's policy chain. */
  deny?: string[];
  /** Ceiling on the published benchmark price for the stage being routed. */
  maxPrice?: number;
  tts?: {
    model?: string;
    voice?: string;
    /** Delivery direction: speaking style or accent, without changing the transcript. */
    instructions?: string;
    speed?: number;
  };
  stt?: {
    model?: string;
  };
};

export const SPEKO_DEFAULT_BASE_URL = "https://api.speko.ai/v1";

/**
 * Shipped default language.
 *
 * Without a header the router falls back to whatever language the API key's
 * policy carries, which is invisible from here and is not always English — a
 * first run can quietly come back in another language and read as a bug. So the
 * plugin is explicit by default and `"auto"` opts back into the key's policy.
 */
export const SPEKO_DEFAULT_LANGUAGE = "en";

/** Sentinel that means "send no language header; defer to the key's policy". */
export const SPEKO_LANGUAGE_AUTO = "auto";

export function normalizeSpekoBaseUrl(baseUrl: string | undefined): string {
  const raw = (baseUrl ?? SPEKO_DEFAULT_BASE_URL).trim();
  return raw.replace(/\/+$/, "");
}

/**
 * Reads the plugin's config block out of an OpenClaw config object without
 * depending on the host config type, which is not part of the plugin SDK
 * surface for arbitrary plugin ids.
 */
export function readSpekoConfig(cfg: unknown): SpekoPluginConfig {
  const entries = (cfg as { plugins?: { entries?: Record<string, { config?: unknown }> } } | undefined)?.plugins
    ?.entries;
  const config = entries?.speko?.config;
  return isRecord(config) ? (config as SpekoPluginConfig) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the `X-Speko-*` routing headers. Every field except `language` falls
 * through to the API key's own policy when unset; `language` defaults to `en` so
 * a first run is predictable, and `"auto"` restores the fall-through.
 */
export function buildRoutingHeaders(config: SpekoPluginConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  const language = config.language ?? SPEKO_DEFAULT_LANGUAGE;
  if (language !== SPEKO_LANGUAGE_AUTO) headers["X-Speko-Language"] = language;
  if (config.objective) headers["X-Speko-Objective"] = config.objective;
  if (config.allow?.length) headers["X-Speko-Allow"] = config.allow.join(",");
  if (config.deny?.length) headers["X-Speko-Deny"] = config.deny.join(",");
  if (typeof config.maxPrice === "number") headers["X-Speko-Max-Price"] = String(config.maxPrice);
  return headers;
}

/** What the router actually dialed, read back off the response. */
export type SpekoRouteDecision = {
  route?: string;
  reason?: string;
  failoverCount?: number;
  firstByteMs?: number;
};

export function readRouteDecision(headers: Headers): SpekoRouteDecision {
  const failover = headers.get("x-speko-failover-count");
  const firstByte = headers.get("x-speko-first-byte-ms");
  return {
    route: headers.get("x-route") ?? undefined,
    reason: headers.get("x-route-reason") ?? undefined,
    failoverCount: failover === null ? undefined : Number(failover),
    firstByteMs: firstByte === null ? undefined : Number(firstByte),
  };
}

export function formatRouteDecision(decision: SpekoRouteDecision): string {
  const parts = [decision.route ?? "unknown route"];
  if (decision.reason) parts.push(decision.reason);
  if (decision.failoverCount) parts.push(`failover=${decision.failoverCount}`);
  if (typeof decision.firstByteMs === "number") parts.push(`ttfb=${decision.firstByteMs}ms`);
  return parts.join(" | ");
}
