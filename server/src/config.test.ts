import { describe, expect, it } from "vitest";
import path from "node:path";
import { selectWritableRuntimeConfig } from "./config.js";

describe("runtime configuration paths", () => {
  it("preserves an existing legacy user configuration", () => {
    const legacyRoot = "/Users/test/AI/muse-glimmer";
    const legacyConfig = path.join(legacyRoot, "config", "mcp-servers.json");
    expect(
      selectWritableRuntimeConfig(
        "mcp-servers.json",
        "/Users/test/.muse-glimmer",
        legacyRoot,
        (file) => file === legacyConfig,
      ),
    ).toBe(legacyConfig);
  });

  it("uses writable state instead of a read-only bundled orchestrator directory", () => {
    expect(
      selectWritableRuntimeConfig(
        "mcp-servers.json",
        "/Users/test/.muse-glimmer",
        "/Applications/Glimmer.app/Contents/Resources/orchestrator",
        () => false,
      ),
    ).toBe("/Users/test/.muse-glimmer/mcp-servers.json");
  });
});
