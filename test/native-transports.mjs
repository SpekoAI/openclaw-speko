// Tests emitted package files against loopback only. No OpenClaw profile or provider is needed.
// Run with Node 24: node test/native-transports.mjs [extracted-package-directory]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const packageRoot = path.resolve(process.argv[2] ?? root);
const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const marker = `openclaw-speko/${pkg.version}`;
const routerKey = "synthetic-router-key";
const platformKey = "synthetic-platform-key";
const baseUrl = "http://router.example.com/v1";
const WAV = Buffer.from("RIFF....WAVEfmt synthetic", "utf8");
const audio = Buffer.from("RIFF synthetic upload", "utf8");
const row = {
  id: "fixture:model", model: "model", provider: "fixture", api: "llm", routable: true,
  costPerMinUsd: 1, quality: 1, qualityUnit: "score", latencyMs: 1, languages: ["en"],
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
const load = (file) => import(pathToFileURL(path.join(packageRoot, "dist", file)).href);

async function child() {
  const require = createRequire(path.join(root, "package.json"));
  const host = path.resolve(path.dirname(require.resolve("openclaw/plugin-sdk/provider-http")), "../..");
  const hostPkg = JSON.parse(readFileSync(path.join(host, "package.json"), "utf8"));
  assert.equal(hostPkg.version, "2026.7.1-2");
  // Apply the same host proxy bootstrap that its daemon uses, with our loopback proxy.
  // Importing the peer's separate Undici runtime otherwise replaces Node's initial dispatcher.
  const { r: ensureProxy } = await import(pathToFileURL(path.join(host, "dist", "undici-global-dispatcher-DeobtFo9.js")).href);
  ensureProxy();
  const { fetchSpekoModels } = await load("models.js");
  const { synthesizeSpeko } = await load("speech.js");
  const { transcribeSpeko } = await load("transcribe.js");
  const { createModelsTool, createRoutingPreviewTool } = await load("tools.js");
  const config = { apiKey: routerKey, baseUrl, language: "en", objective: "quality", maxPrice: 3 };
  assert.deepEqual(await fetchSpekoModels({ apiKey: routerKey, baseUrl, signal: AbortSignal.timeout(5000) }), [row]);
  const speech = await synthesizeSpeko({
    text: "Synthetic speech.", config: { apiKey: routerKey, baseUrl, routing: config }, timeoutMs: 5000,
    overrides: { model: "fixture:model", voice: "fixture-voice", speed: 1.1 },
  });
  assert.deepEqual(speech.audioBuffer, WAV);
  assert.equal(speech.outputFormat, "wav");
  assert.equal(speech.route, "fixture/model");
  assert.deepEqual(await transcribeSpeko({
    buffer: audio, fileName: "fixture.wav", mime: "audio/wav", apiKey: routerKey,
    baseUrl, routing: config, timeoutMs: 5000,
  }), { text: "Synthetic transcript.", model: "fixture/model" });
  const deps = { resolveApiKey: () => routerKey, resolveConfig: () => config };
  await createRoutingPreviewTool(deps).execute("fixture-preview", { stage: "llm", language: "en" });
  const models = await createModelsTool(deps).execute("fixture-models", { stage: "llm", language: "en" });
  assert.equal(models.details.models.length, 1);

  const { default: entry } = await load("index.js");
  let provider;
  entry.register({
    config: {}, pluginConfig: config, registerProvider: (value) => { provider = value; },
    registerModelCatalogProvider() {}, registerSpeechProvider() {},
    registerMediaUnderstandingProvider() {}, registerTool() {},
  });
  const ctx = { resolveProviderApiKey: () => ({ apiKey: routerKey }) };
  const catalog = (await provider.catalog.run(ctx)).provider;
  config.baseUrl = "http://router.example.com/unavailable/v1";
  const fallback = (await provider.catalog.run(ctx)).provider;
  config.baseUrl = baseUrl;
  const dynamic = provider.resolveDynamicModel({ modelId: "fixture:dynamic" });

  // This is the exact host implementation selected for openai-completions in the frozen peer.
  // It is an internal test import, not a new plugin dependency on an internal host API.
  const files = readdirSync(path.join(host, "dist")).filter((name) => /^openai-transport-stream-.*\.js$/.test(name));
  assert.equal(files.length, 1);
  const source = readFileSync(path.join(host, "dist", files[0]), "utf8");
  assert.match(source, /createOpenAICompletionsTransportStreamFn as r/);
  const { r: createStream } = await import(pathToFileURL(path.join(host, "dist", files[0])).href);
  const stream = createStream();
  const context = { messages: [{ role: "user", content: "Synthetic prompt.", timestamp: 0 }] };
  const selected = [catalog.models[0], catalog.models[1], fallback.models[0], dynamic];
  for (const definition of selected) {
    assert.deepEqual(definition.headers, { "User-Agent": marker });
    const model = { ...definition, provider: "speko", api: "openai-completions", baseUrl };
    const output = stream(model, context, { apiKey: routerKey, maxTokens: 8 });
    const observed = [];
    for await (const event of output) observed.push(event);
    const result = await output.result();
    assert.equal(result.stopReason, "stop");
    assert.equal(result.content.filter((block) => block.type === "text").map((block) => block.text).join(""), "Hello fixture");
    assert.ok(observed.some((event) => event.type === "text_delta"));
  }
  // Explicit caller headers retain the host's existing precedence, including User-Agent casing.
  const model = { ...selected[0], provider: "speko", api: "openai-completions", baseUrl };
  const overridden = stream(model, context, {
    apiKey: routerKey, maxTokens: 8,
    headers: { "uSeR-aGeNt": "synthetic-caller/1", "X-Fixture-Caller": "preserved", "x-session-id": "synthetic-session" },
  });
  for await (const event of overridden) { /* Drain the actual native SSE stream. */ }
  assert.equal((await overridden.result()).stopReason, "stop");
  await assert.rejects(fetchSpekoModels({ apiKey: "synthetic-rejected-key", baseUrl }), /401/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(fetchSpekoModels({ apiKey: routerKey, baseUrl, signal: abort.signal }), { name: "AbortError" });
  console.log("NATIVE_HOST_RESULT:" + JSON.stringify({ status: "pass", hostVersion: hostPkg.version, hostTransportSha256: sha(source) }));
}

async function command(command, args, env) {
  const process = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => process.kill("SIGKILL"), 25000);
  process.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 1048576) process.kill("SIGKILL"); });
  process.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 1048576) process.kill("SIGKILL"); });
  const code = await new Promise((resolve, reject) => { process.once("error", reject); process.once("close", resolve); });
  clearTimeout(timer);
  return { code, stdout, stderr };
}

async function main() {
  const state = mkdtempSync(path.join(tmpdir(), "speko-openclaw-native-"));
  const environment = {
    PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
    OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: path.join(state, "state"),
    OPENCLAW_CONFIG_PATH: path.join(state, "config.json"), CURL_HOME: state,
  };
  const requests = [];
  const failures = [];
  const server = createServer(async (req, res) => {
    try {
      assert.ok(requests.length < 24);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; assert.ok(size < 65536); chunks.push(chunk); }
      const body = Buffer.concat(chunks);
      const headers = req.headers;
      requests.push({ method: req.method, url: url.href, headers, bodyBytes: body.length, bodySha256: sha(body) });
      const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (url.hostname === "router.example.com") {
        if (headers.authorization === "Bearer synthetic-rejected-key") return json({ error: "synthetic rejection" }, 401);
        assert.equal(headers.authorization, `Bearer ${routerKey}`);
        if (url.pathname === "/unavailable/v1/models") return json({ error: "synthetic unavailable" }, 503);
        if (url.pathname === "/v1/models") { assert.equal(req.method, "GET"); return json({ data: [row] }); }
        if (url.pathname === "/v1/routing/preview") {
          assert.equal(req.method, "GET");
          assert.equal(url.searchParams.get("stage"), "llm");
          assert.equal(url.searchParams.get("language"), "en");
          return json({ id: "fixture:model", model: "model", provider: "fixture", language: "en", language_recognized: true, objective: "quality", reason: "fixture", evidence: "measured" });
        }
        if (url.pathname === "/v1/audio/speech") {
          assert.equal(req.method, "POST");
          assert.equal(headers["content-type"], "application/json");
          assert.equal(headers["x-speko-language"], "en");
          assert.equal(headers["x-speko-objective"], "quality");
          assert.equal(headers["x-speko-max-price"], "3");
          assert.deepEqual(JSON.parse(body), { model: "fixture:model", input: "Synthetic speech.", response_format: "wav", voice: "fixture-voice", speed: 1.1 });
          res.writeHead(200, { "content-type": "audio/wav", "x-route": "fixture/model" });
          res.write(WAV.subarray(0, 4));
          setTimeout(() => res.end(WAV.subarray(4)), 5);
          return;
        }
        if (url.pathname === "/v1/audio/transcriptions") {
          assert.equal(req.method, "POST");
          assert.match(headers["content-type"], /^multipart\/form-data; boundary=/);
          assert.equal(headers["x-speko-language"], "en");
          const form = await new Response(body, { headers: { "content-type": headers["content-type"] } }).formData();
          assert.equal(form.get("model"), "auto");
          assert.equal(form.get("language"), "en");
          assert.equal(form.get("file").name, "fixture.wav");
          assert.equal(form.get("file").type, "audio/wav");
          assert.deepEqual(Buffer.from(await form.get("file").arrayBuffer()), audio);
          return json({ text: "Synthetic transcript.", model: "fixture/model" });
        }
        if (url.pathname === "/v1/chat/completions") {
          assert.equal(req.method, "POST");
          const payload = JSON.parse(body);
          assert.equal(payload.stream, true);
          assert.equal(Object.hasOwn(payload, "store"), false);
          assert.equal(payload.messages[0].content, "Synthetic prompt.");
          res.writeHead(200, { "content-type": "text/event-stream" });
          const part = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "synthetic-chat", object: "chat.completion.chunk", created: 0, model: payload.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          res.write(part({ role: "assistant", content: "Hello " }));
          setTimeout(() => { res.write(part({ content: "fixture" })); res.end(part({}, "stop") + "data: [DONE]\n\n"); }, 5);
          return;
        }
      } else {
        assert.equal(url.hostname, "127.0.0.1");
        assert.equal(headers.authorization, `Bearer ${platformKey}`);
        assert.equal(headers["user-agent"], marker);
        if (url.pathname === "/v1/phone-numbers") { assert.equal(req.method, "GET"); return json([]); }
        if (url.pathname === "/v1/sessions/phone") {
          assert.equal(req.method, "POST");
          assert.equal(headers["content-type"], "application/json");
          assert.deepEqual(JSON.parse(body), { to: "+15551234567", from: "+15557654321", intent: { language: "en" }, systemPrompt: "You are calling to confirm a delivery window. Be brief.", firstMessage: "Hi, this is an assistant calling about your delivery." });
          return json({ sessionId: "synthetic-call" });
        }
        assert.match(url.pathname, /^\/v1\/calls\/11111111-1111-4111-8111-111111111111(?:\/report)?$/);
        assert.equal(req.method, "GET");
        return json({ status: "ended", duration_seconds: 0, ended_at: null, summary: "synthetic", outcome: "synthetic", cost_micro_usd: 0 });
      }
      throw new Error("Unexpected local fixture request");
    } catch (error) { failures.push(String(error)); res.writeHead(500); res.end("fixture failure"); }
  });
  // Undici uses CONNECT even for an HTTP destination. Terminate that synthetic tunnel here;
  // never connect to the destination host or change the package's fetch implementation.
  server.on("connect", (req, socket, head) => {
    if (req.url !== "router.example.com:80") {
      failures.push("Unexpected proxy destination");
      socket.destroy();
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    server.emit("connection", socket);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await command(process.execPath, [fileURLToPath(import.meta.url), packageRoot, "--child"], {
      ...environment, HTTP_PROXY: local, http_proxy: local, NODE_USE_ENV_PROXY: "1", NO_PROXY: "", no_proxy: "",
    });
    assert.equal(result.code, 0, result.stderr + result.stdout + JSON.stringify({ failures, requests }));
    const routerRequests = requests.filter((request) => new URL(request.url).hostname === "router.example.com");
    assert.equal(routerRequests.length, 14);
    for (const request of routerRequests) {
      const callerOverride = request.headers["x-fixture-caller"] === "preserved";
      assert.equal(request.headers["user-agent"], callerOverride ? "synthetic-caller/1" : marker);
      if (callerOverride) assert.equal(request.headers["x-session-id"], "synthetic-session");
    }
    assert.equal(routerRequests.filter((request) => request.headers["x-fixture-caller"] === "preserved").length, 1);

    // The phone skill is a separately distributed source file, excluded from the npm artifact.
    // Execute its four actual curl commands with only the receiver changed to the loopback fixture.
    const skill = readFileSync(path.join(root, "skill/speko-calls/SKILL.md"), "utf8");
    const commands = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((match) => match[1].trim().split(/\n\n/));
    assert.equal(commands.length, 4);
    for (const source of commands) {
      assert.ok(source.startsWith("curl -s https://api.speko.dev/v1/"));
      const actual = source.replaceAll("https://api.speko.dev", local);
      const call = await command("/bin/bash", ["-c", actual], {
        ...environment, SPEKO_PLATFORM_API_KEY: platformKey, ID: "11111111-1111-4111-8111-111111111111", NO_PROXY: "*", no_proxy: "*",
      });
      assert.equal(call.code, 0, call.stderr);
    }
    assert.equal(requests.length, 18);
    assert.deepEqual(failures, []);
    const hostResults = result.stdout.split("\n").filter((line) => line.startsWith("NATIVE_HOST_RESULT:"));
    assert.equal(hostResults.length, 1);
    console.log(JSON.stringify({ status: "pass", package: pkg.name, version: pkg.version, node: process.version,
      artifactRoot: packageRoot, host: JSON.parse(hostResults[0].slice("NATIVE_HOST_RESULT:".length)),
      hostStdout: result.stdout, hostStderr: result.stderr, routerRequests: 14, platformSkillRequests: 4,
      nativeFetch: true, nativeHostStreaming: true, nativeCurl: true, factoryOrFetchStubs: false,
      phoneSkillSourceSha256: sha(skill), requests, limits: ["Loopback fixture only; no provider or receiver ingestion proof.", "Explicit caller User-Agent keeps precedence and can replace the default package marker.", "The phone skill is tested separately from the npm package.", "The full OpenClaw daemon and third-party provider WebSockets are not exercised."] }, null, 2));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(state, { recursive: true, force: true });
  }
}

if (process.argv[3] === "--child") await child();
else await main();
