import { assertOkOrThrowProviderError, postJsonRequest } from "openclaw/plugin-sdk/provider-http";
import {
  buildRoutingHeaders,
  formatRouteDecision,
  normalizeSpekoBaseUrl,
  readRouteDecision,
  readSpekoConfig,
  type SpekoPluginConfig,
} from "./config.js";

export type SpekoSpeechProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  routing: SpekoPluginConfig;
};

/**
 * Normalizes the plugin's config block into the provider-owned config the
 * speech runtime carries through to `synthesize`.
 */
export function resolveSpeechConfig(cfg: unknown, env: NodeJS.ProcessEnv = process.env): SpekoSpeechProviderConfig {
  const routing = readSpekoConfig(cfg);
  return {
    apiKey: routing.apiKey ?? env.SPEKO_API_KEY,
    baseUrl: normalizeSpekoBaseUrl(routing.baseUrl),
    routing,
  };
}

export type SpekoSynthesisOutcome = {
  audioBuffer: Buffer;
  outputFormat: string;
  fileExtension: string;
  voiceCompatible: boolean;
  route: string;
};

/**
 * Buffered synthesis against `POST /v1/audio/speech`.
 *
 * Deliberately NOT the streaming route: `/v1/audio/speech/stream` has no
 * empty-body guard, so under concurrency it can commit a 200 and then return
 * zero bytes, while the buffered route answers 502 with a failover count when
 * a vendor refuses. A silent empty reply is worse than a loud failure here.
 *
 * `response_format: "wav"` is required rather than nice-to-have: the router's
 * default is headerless raw PCM, which no player opens, and it refuses encoded
 * formats such as mp3 outright.
 */
export async function synthesizeSpeko(params: {
  text: string;
  config: SpekoSpeechProviderConfig;
  timeoutMs: number;
  overrides?: { model?: string; voice?: string; instructions?: string; speed?: number };
  fetchFn?: typeof fetch;
}): Promise<SpekoSynthesisOutcome> {
  const { config } = params;
  if (!config.apiKey) {
    throw new Error("Speko speech provider is not configured: set SPEKO_API_KEY or plugins.entries.speko.config.apiKey");
  }
  const tts = config.routing.tts ?? {};
  const body: Record<string, unknown> = {
    model: params.overrides?.model ?? tts.model ?? "auto",
    input: params.text,
    response_format: "wav",
  };
  const voice = params.overrides?.voice ?? tts.voice;
  if (voice) body.voice = voice;
  const instructions = params.overrides?.instructions ?? tts.instructions;
  if (instructions) body.instructions = instructions;
  const speed = params.overrides?.speed ?? tts.speed;
  if (typeof speed === "number") body.speed = speed;

  const headers = new Headers({ "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` });
  for (const [key, value] of Object.entries(buildRoutingHeaders(config.routing))) headers.set(key, value);

  const { response, release } = await postJsonRequest({
    url: `${normalizeSpekoBaseUrl(config.baseUrl)}/audio/speech`,
    headers,
    body,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn ?? fetch,
    auditContext: "speko speech",
  });
  try {
    await assertOkOrThrowProviderError(response, "Speko speech API error");
    const decision = readRouteDecision(response.headers);
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    if (audioBuffer.length === 0) {
      throw new Error(`Speko speech returned an empty body (${formatRouteDecision(decision)})`);
    }
    return {
      audioBuffer,
      outputFormat: "wav",
      fileExtension: ".wav",
      // WAV is not a native voice-note container on any channel, so the host
      // transcodes rather than sending these bytes through as a voice message.
      voiceCompatible: false,
      route: formatRouteDecision(decision),
    };
  } finally {
    await release();
  }
}
