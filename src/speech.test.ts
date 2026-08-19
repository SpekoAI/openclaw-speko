import { describe, expect, it } from "vitest";
import { resolveSpeechConfig, synthesizeSpeko } from "./speech.js";

const WAV = Buffer.from("RIFF....WAVEfmt ", "utf8");

function stubFetch(response: Response, captured: { request?: Request } = {}) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.request = new Request(input as never, init);
    return response;
  }) as unknown as typeof fetch;
}

describe("speech synthesis", () => {
  const config = {
    apiKey: "sk_test",
    baseUrl: "https://api.speko.ai/v1",
    routing: { language: "nb", objective: "quality" as const },
  };

  it("asks for wav, because the router's default body is headerless pcm no player opens", async () => {
    const captured: { request?: Request } = {};
    const outcome = await synthesizeSpeko({
      text: "Hei.",
      config,
      timeoutMs: 5_000,
      fetchFn: stubFetch(
        new Response(WAV, { status: 200, headers: { "content-type": "audio/wav", "x-route": "ElevenLabs/eleven_v3" } }),
        captured,
      ),
    });
    const body = (await captured.request?.json()) as { response_format: string; model: string };
    expect(body.response_format).toBe("wav");
    expect(body.model).toBe("auto");
    expect(outcome.fileExtension).toBe(".wav");
    expect(outcome.route).toContain("ElevenLabs/eleven_v3");
  });

  it("forwards the routing overrides as headers", async () => {
    const captured: { request?: Request } = {};
    await synthesizeSpeko({
      text: "Hei.",
      config,
      timeoutMs: 5_000,
      fetchFn: stubFetch(new Response(WAV, { status: 200 }), captured),
    });
    expect(captured.request?.headers.get("x-speko-language")).toBe("nb");
    expect(captured.request?.headers.get("x-speko-objective")).toBe("quality");
  });

  it("fails loudly on a 200 that carries no audio", async () => {
    await expect(
      synthesizeSpeko({
        text: "Hei.",
        config,
        timeoutMs: 5_000,
        fetchFn: stubFetch(new Response(new ArrayBuffer(0), { status: 200, headers: { "x-route": "Soniox/tts-rt-v1" } })),
      }),
    ).rejects.toThrow(/empty body/);
  });

  it("refuses to run unconfigured instead of sending an unauthenticated request", async () => {
    await expect(
      synthesizeSpeko({ text: "Hei.", config: { routing: {} }, timeoutMs: 1_000, fetchFn: stubFetch(new Response()) }),
    ).rejects.toThrow(/not configured/);
  });
});

describe("speech config resolution", () => {
  it("falls back to the environment key", () => {
    const resolved = resolveSpeechConfig({}, { SPEKO_API_KEY: "sk_env" } as NodeJS.ProcessEnv);
    expect(resolved.apiKey).toBe("sk_env");
    expect(resolved.baseUrl).toBe("https://api.speko.ai/v1");
  });

  it("prefers the explicit plugin config key", () => {
    const cfg = { plugins: { entries: { speko: { config: { apiKey: "sk_cfg" } } } } };
    expect(resolveSpeechConfig(cfg, { SPEKO_API_KEY: "sk_env" } as NodeJS.ProcessEnv).apiKey).toBe("sk_cfg");
  });
});
