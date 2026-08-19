import { describe, expect, it } from "vitest";
import {
  selectRoutableStage,
  SPEKO_AUTO_MODEL_ID,
  toOpenClawCost,
  toOpenClawModelRows,
  type SpekoModelRow,
} from "./models.js";

function row(overrides: Partial<SpekoModelRow>): SpekoModelRow {
  return {
    id: "cerebras:gemma-4-31b",
    model: "gemma-4-31b",
    provider: "Cerebras",
    api: "llm",
    routable: true,
    costPerMinUsd: 1.49,
    quality: 82,
    qualityUnit: "score",
    latencyMs: 192,
    languages: ["en", "es"],
    ...overrides,
  };
}

describe("stage selection", () => {
  it("keeps only routable rows for the requested stage", () => {
    const rows = [
      row({}),
      row({ id: "livekit:google/gemma-4-31b-it", routable: false }),
      row({ id: "deepgram:nova-3", api: "stt" }),
    ];
    expect(selectRoutableStage(rows, "llm").map((r) => r.id)).toEqual(["cerebras:gemma-4-31b"]);
    expect(selectRoutableStage(rows, "stt").map((r) => r.id)).toEqual(["deepgram:nova-3"]);
  });
});

describe("openclaw model rows", () => {
  it("leads with the routed model so the picker default hands routing to the benchmarks", () => {
    const models = toOpenClawModelRows([row({})]);
    expect(models[0]?.id).toBe(SPEKO_AUTO_MODEL_ID);
    expect(models[0]?.name).toContain("price varies");
  });

  it("carries the blended published price on every cost side", () => {
    const models = toOpenClawModelRows([row({})]);
    expect(models[1]?.cost).toEqual({ input: 1.49, output: 1.49, cacheRead: 1.49, cacheWrite: 1.49 });
  });

  it("labels an unpriced model instead of letting a zero read as free", () => {
    const models = toOpenClawModelRows([row({ costPerMinUsd: null })]);
    expect(models[1]?.name).toContain("no published price");
    expect(models[1]?.cost.input).toBe(0);
  });

  it("drops stt and tts rows from the text catalog", () => {
    const models = toOpenClawModelRows([row({ api: "tts", id: "elevenlabs:eleven_v3" })]);
    expect(models.map((m) => m.id)).toEqual([SPEKO_AUTO_MODEL_ID]);
  });
});

describe("cost mapping", () => {
  it("treats a missing price as zero on all four sides", () => {
    expect(toOpenClawCost(null)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});
