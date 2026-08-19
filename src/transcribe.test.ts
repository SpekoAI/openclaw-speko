import { describe, expect, it } from "vitest";
import { transcribeSpeko } from "./transcribe.js";

function stubFetch(response: Response, captured: { request?: Request } = {}) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.request = new Request(input as never, init);
    return response;
  }) as unknown as typeof fetch;
}

describe("transcription", () => {
  it("posts multipart with a model, and lets the client own the boundary", async () => {
    const captured: { request?: Request } = {};
    const result = await transcribeSpeko({
      buffer: Buffer.from("RIFF"),
      fileName: "note.wav",
      mime: "audio/wav",
      apiKey: "sk_test",
      baseUrl: "https://api.speko.ai/v1",
      routing: { language: "ta" },
      timeoutMs: 5_000,
      fetchFn: stubFetch(
        new Response(JSON.stringify({ text: "vanakkam" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-route": "AssemblyAI/universal-3-5-pro" },
        }),
        captured,
      ),
    });
    expect(result.text).toBe("vanakkam");
    expect(result.model).toBe("AssemblyAI/universal-3-5-pro");
    expect(captured.request?.url).toBe("https://api.speko.ai/v1/audio/transcriptions");
    expect(captured.request?.headers.get("x-speko-language")).toBe("ta");
    const contentType = captured.request?.headers.get("content-type") ?? "";
    expect(contentType).toContain("multipart/form-data");
    expect(contentType).toContain("boundary=");
    const form = await captured.request!.formData();
    expect(form.get("model")).toBe("auto");
    expect(form.get("language")).toBe("ta");
  });

  it("treats an empty transcript as a failure, not as silence", async () => {
    await expect(
      transcribeSpeko({
        buffer: Buffer.from("RIFF"),
        fileName: "note.wav",
        apiKey: "sk_test",
        timeoutMs: 5_000,
        fetchFn: stubFetch(
          new Response(JSON.stringify({ text: "" }), { status: 200, headers: { "content-type": "application/json" } }),
        ),
      }),
    ).rejects.toThrow();
  });
});
