import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseResourceTaxonomyYaml } from "../resource-routing/taxonomy.js";

describe("resource routing packaging", () => {
  it("ships the resource-routing directory in npm and install manifests", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const installManifest = JSON.parse(await readFile(new URL("../install-manifest.json", import.meta.url), "utf8"));
    expect(packageJson.files).toContain("resource-routing/");
    expect(installManifest.files.required).toContain("resource-routing/");
  });

  it("ships a valid baseline taxonomy with the configured default inbox key", async () => {
    const yaml = await readFile(new URL("../resource-routing/default-taxonomy.yaml", import.meta.url), "utf8");
    const taxonomy = parseResourceTaxonomyYaml(yaml);
    expect(taxonomy.byKey.get("inbox")).toMatchObject({
      key: "inbox",
      segment: "__INBOX__",
      routeable: true,
    });
    expect(taxonomy.categories.length).toBeGreaterThan(20);
  });
});
