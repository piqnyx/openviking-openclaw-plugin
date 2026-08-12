import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  inferResourceRoutingMimeType,
  renderResourceRoutingSemanticInput,
} from "../routing/resource-routing-semantic-input.js";

describe("resource routing final release contracts", () => {
  it("keeps automatic add_resource language-aware, provenance-aware, deterministic, and explicit-category-safe", () => {
    const source = readFileSync(
      join(process.cwd(), "plugin", "openviking-import-tools.ts"),
      "utf8",
    );
    expect(source).toContain("summaryLanguage");
    expect(source).toContain("batch scraping or crawling result");
    expect(source).toContain("exported chat or forum history");
    expect(source).toContain("database dump");
    expect(source).toContain("Automatic resource routing requires `summary`");
    expect(source).toContain("Set category ONLY when the user's current request explicitly names the exact taxonomy destination/path/key");
    expect(source).toContain("Invalid explicit categories are rejected without importing anything");
    expect(source).toContain("Do not guess another category");
    expect(source).toContain("resolveCategoryOrFallback");
    expect(source).toContain("wait: false");
  });

  it("ships docs, reviewed examples and operational routing tools with version parity", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version?: string;
      files?: string[];
    };
    const installManifest = JSON.parse(
      readFileSync(join(process.cwd(), "install-manifest.json"), "utf8"),
    ) as {
      pluginVersion?: string;
      files?: { required?: string[] };
    };

    expect(installManifest.pluginVersion).toBe(pkg.version);
    expect(pkg.files).toContain("docs/");
    expect(pkg.files).toContain("examples/");
    expect(pkg.files).toContain("tools/");
    expect(installManifest.files?.required).toContain("docs/resource-routing.md");
    expect(installManifest.files?.required).toContain("examples/");
    expect(installManifest.files?.required).toContain("tools/");
  });

  it("makes documented mimeType template metadata useful without changing summary-only defaults", () => {
    expect(inferResourceRoutingMimeType("pdf")).toBe("application/pdf");
    expect(inferResourceRoutingMimeType(".PNG")).toBe("image/png");
    expect(inferResourceRoutingMimeType("unknown-extension")).toBeUndefined();

    expect(renderResourceRoutingSemanticInput(
      "{{summary}}\nMIME: {{mimeType}}",
      {
        summary: "A security assessment report.",
        extension: "pdf",
      },
    )).toBe("A security assessment report.\nMIME: application/pdf");

    expect(renderResourceRoutingSemanticInput(
      "{{summary}}\nMIME: {{mimeType}}",
      {
        summary: "A custom-format resource.",
        extension: "pdf",
        mimeType: "application/x-custom",
      },
    )).toBe("A custom-format resource.\nMIME: application/x-custom");
  });
});
