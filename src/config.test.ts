import { describe, expect, it } from "vitest";
import {
  buildRoutingHeaders,
  formatRouteDecision,
  normalizeSpekoBaseUrl,
  readRouteDecision,
  readSpekoConfig,
  SPEKO_DEFAULT_BASE_URL,
} from "./config.js";

describe("routing headers", () => {
  it("emits nothing when no override is configured, so the key policy stands", () => {
    expect(buildRoutingHeaders({})).toEqual({});
  });

  it("maps every override onto its documented header", () => {
    expect(
      buildRoutingHeaders({
        language: "es-MX",
        objective: "latency",
        allow: ["cartesia:sonic-3.5", "deepgram:aura-2"],
        deny: ["openai:gpt-5"],
        maxPrice: 4.5,
      }),
    ).toEqual({
      "X-Speko-Language": "es-MX",
      "X-Speko-Objective": "latency",
      "X-Speko-Allow": "cartesia:sonic-3.5,deepgram:aura-2",
      "X-Speko-Deny": "openai:gpt-5",
      "X-Speko-Max-Price": "4.5",
    });
  });

  it("keeps a zero price ceiling, which is a real constraint and not an absent one", () => {
    expect(buildRoutingHeaders({ maxPrice: 0 })["X-Speko-Max-Price"]).toBe("0");
  });
});

describe("base url", () => {
  it("defaults to the router and strips trailing slashes", () => {
    expect(normalizeSpekoBaseUrl(undefined)).toBe(SPEKO_DEFAULT_BASE_URL);
    expect(normalizeSpekoBaseUrl("https://example.test/v1///")).toBe("https://example.test/v1");
  });
});

describe("config reading", () => {
  it("reads the plugin config block", () => {
    const cfg = { plugins: { entries: { speko: { config: { language: "hi" } } } } };
    expect(readSpekoConfig(cfg).language).toBe("hi");
  });

  it("returns an empty config rather than throwing on unexpected shapes", () => {
    expect(readSpekoConfig(undefined)).toEqual({});
    expect(readSpekoConfig({ plugins: { entries: { speko: { config: "nope" } } } })).toEqual({});
  });
});

describe("route decision", () => {
  it("reads what was actually dialed off the response headers", () => {
    const headers = new Headers({
      "x-route": "Cartesia/ink-2",
      "x-route-reason": "balanced:score=0.839;lang=en(measured)",
      "x-speko-failover-count": "2",
      "x-speko-first-byte-ms": "410",
    });
    const decision = readRouteDecision(headers);
    expect(decision.route).toBe("Cartesia/ink-2");
    expect(decision.failoverCount).toBe(2);
    expect(decision.firstByteMs).toBe(410);
    expect(formatRouteDecision(decision)).toContain("failover=2");
    expect(formatRouteDecision(decision)).toContain("ttfb=410ms");
  });
});
