import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPEKO_USER_AGENT } from "./user-agent.js";

describe("package version marker", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  it("uses the installed package version and keeps the plugin manifest aligned", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(SPEKO_USER_AGENT).toBe(`openclaw-speko/${pkg.version}`);
    expect(manifest.version).toBe(pkg.version);
  });

  it("keeps all four separate Platform skill commands on the same version", () => {
    const skill = readFileSync(new URL("../skill/speko-calls/SKILL.md", import.meta.url), "utf8");
    const markers = [...skill.matchAll(/-H "User-Agent: ([^"]+)"/g)].map((match) => match[1]);
    expect(markers).toEqual(Array(4).fill(SPEKO_USER_AGENT));
    expect([...skill.matchAll(/Authorization: Bearer \$SPEKO_PLATFORM_API_KEY/g)]).toHaveLength(4);
  });
});
