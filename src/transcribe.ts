import {
  assertOkOrThrowProviderError,
  buildAudioTranscriptionFormData,
  postTranscriptionRequest,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";
import { buildRoutingHeaders, normalizeSpekoBaseUrl, type SpekoPluginConfig } from "./config.js";

export type SpekoTranscribeParams = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  routing?: SpekoPluginConfig;
  timeoutMs: number;
  fetchFn?: typeof fetch;
};

export type SpekoTranscribeOutcome = { text: string; model?: string };

/**
 * Batch transcription against `POST /v1/audio/transcriptions`.
 *
 * OpenAI-shaped multipart. `model` is required by the router — "auto" hands the
 * choice to the benchmark ranking. The response is normalized by the router to
 * `{"text": "..."}` regardless of which vendor answered.
 *
 * The multipart Content-Type is left to the HTTP client on purpose: setting it
 * by hand destroys the boundary and the router answers 502.
 */
export async function transcribeSpeko(params: SpekoTranscribeParams): Promise<SpekoTranscribeOutcome> {
  const routing = params.routing ?? {};
  const fields: Record<string, string> = { model: params.model ?? routing.stt?.model ?? "auto" };
  const language = params.language ?? routing.language;
  if (language) fields.language = language;

  const formData = buildAudioTranscriptionFormData({
    buffer: params.buffer,
    fileName: params.fileName,
    mime: params.mime,
    fields,
  });

  const headers = new Headers({ Authorization: `Bearer ${params.apiKey}` });
  for (const [key, value] of Object.entries(buildRoutingHeaders(routing))) headers.set(key, value);

  const { response, release } = await postTranscriptionRequest({
    url: `${normalizeSpekoBaseUrl(params.baseUrl)}/audio/transcriptions`,
    headers,
    body: formData,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn ?? fetch,
    auditContext: "speko transcription",
  });
  try {
    await assertOkOrThrowProviderError(response, "Speko transcription API error");
    const payload = (await response.json()) as { text?: string; model?: string };
    const text = requireTranscriptionText(payload.text, "Speko transcription returned no text");
    return { text, model: payload.model ?? response.headers.get("x-route") ?? undefined };
  } finally {
    await release();
  }
}
