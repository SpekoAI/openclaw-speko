import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  AnyAgentTool,
  MediaUnderstandingProviderPlugin,
  OpenClawPluginApi,
  ProviderPlugin,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import entry from "./index.js";

type Recorded = {
  providers: ProviderPlugin[];
  catalogProviders: { provider: string; kinds: string[] }[];
  speech: SpeechProviderPlugin[];
  media: MediaUnderstandingProviderPlugin[];
  tools: AnyAgentTool[];
};

function register(pluginConfig?: Record<string, unknown>): Recorded {
  const recorded: Recorded = { providers: [], catalogProviders: [], speech: [], media: [], tools: [] };
  const api = {
    config: {},
    pluginConfig,
    registerProvider: (provider: ProviderPlugin) => recorded.providers.push(provider),
    registerModelCatalogProvider: (entryProvider: { provider: string; kinds: string[] }) =>
      recorded.catalogProviders.push({ provider: entryProvider.provider, kinds: entryProvider.kinds }),
    registerSpeechProvider: (provider: SpeechProviderPlugin) => recorded.speech.push(provider),
    registerMediaUnderstandingProvider: (provider: MediaUnderstandingProviderPlugin) => recorded.media.push(provider),
    registerTool: (tool: AnyAgentTool) => recorded.tools.push(tool),
  } as unknown as OpenClawPluginApi;
  entry.register(api);
  return recorded;
}

describe("speko plugin registration", () => {
  it("registers the text provider", () => {
    const recorded = register();
    expect(recorded.providers.map((provider) => provider.id)).toEqual(["speko"]);
    expect(recorded.providers[0]?.envVars).toEqual(["SPEKO_API_KEY"]);
  });

  it("registers speech and transcription, not only telephony-adjacent text", () => {
    const recorded = register();
    expect(recorded.speech.map((provider) => provider.id)).toEqual(["speko"]);
    expect(recorded.media.map((provider) => provider.id)).toEqual(["speko"]);
    expect(recorded.media[0]?.capabilities).toEqual(["audio"]);
  });

  it("exposes routing inspection tools", () => {
    const recorded = register();
    expect(recorded.tools.map((tool) => tool.name)).toEqual(["speko_routing_preview", "speko_models"]);
  });

  it("advertises both text and voice catalog kinds", () => {
    const recorded = register();
    expect(recorded.catalogProviders).toEqual([{ provider: "speko", kinds: ["text", "voice"] }]);
  });

  it("declares every registered tool and provider id in the manifest contracts", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as {
      contracts: { tools: string[]; speechProviders: string[]; mediaUnderstandingProviders: string[] };
    };
    const recorded = register();
    expect(manifest.contracts.tools).toEqual(recorded.tools.map((tool) => tool.name));
    expect(manifest.contracts.speechProviders).toEqual(recorded.speech.map((provider) => provider.id));
    expect(manifest.contracts.mediaUnderstandingProviders).toEqual(recorded.media.map((provider) => provider.id));
  });
});
