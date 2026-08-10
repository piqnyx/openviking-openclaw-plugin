import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("resource routing release documentation", () => {
  it("keeps package, install manifest and lockfile versions aligned", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const installManifest = JSON.parse(await readFile(new URL("../install-manifest.json", import.meta.url), "utf8"));
    const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));

    expect(packageJson.version).toBe("2026.7.15-isolation.7");
    expect(installManifest.pluginVersion).toBe(packageJson.version);
    expect(lock.version).toBe(packageJson.version);
    expect(lock.packages[""].version).toBe(packageJson.version);
  });

  it("documents the routing safety and tuning contract in README", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("2026.7.15-isolation.7");
    expect(readme).toContain("50 Unicode characters");
    expect(readme).toContain("4096");
    expect(readme).toContain("summary` is not `reason");
    expect(readme).toContain("retrieval.topK");
    expect(readme).toContain("Semantic uncertainty");
    expect(readme).toContain("Infrastructure failure");
    expect(readme).toContain("routeable **and** contain children");
  });

  it("keeps the bundled operator skill aware of routed add/remove resource tools", async () => {
    const skill = await readFile(new URL("../skills/openviking-context-database/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain("category");
    expect(skill).toContain("summary");
    expect(skill).toContain("create_parent");
    expect(skill).toContain("### `remove_resource`");
    expect(skill).toContain("__INBOX__");
    expect(skill).toContain("infrastructure");
  });
});
