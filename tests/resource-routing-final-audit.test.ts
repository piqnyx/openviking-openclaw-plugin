import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  inferResourceRoutingMimeType,
  renderResourceRoutingSemanticInput,
} from "../routing/resource-routing-semantic-input.js";

describe("resource routing final release contracts", () => {
  it("keeps automatic add_resource summary guidance explicit and retryable", () => {
    const source = readFileSync(
      join(process.cwd(), "plugin", "openviking-import-tools.ts"),
      "utf8",
    );
    const skill = readFileSync(
      join(process.cwd(), "skills", "openviking-context-database", "SKILL.md"),
      "utf8",
    );
    expect(source).toContain("MUST provide summary");
    expect(source).toContain("Automatic resource routing requires `summary`");
    expect(source).toContain("Then retry add_resource with that summary");
    expect(source).toContain("online article, email thread, meeting transcript, or terminal screenshot");
    expect(skill).toContain("online article, email thread, meeting transcript, or terminal screenshot");
  });

  it("ships the detailed resource-routing documentation in packaged releases", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      files?: string[];
    };
    const installManifest = JSON.parse(
      readFileSync(join(process.cwd(), "install-manifest.json"), "utf8"),
    ) as {
      files?: { required?: string[] };
    };

    expect(pkg.files).toContain("docs/");
    expect(installManifest.files?.required).toContain("docs/resource-routing.md");
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
