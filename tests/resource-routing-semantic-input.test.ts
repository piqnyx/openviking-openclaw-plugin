import { describe, expect, it } from "vitest";

import {
  renderResourceSemanticInput,
  requireResourceSemanticSummary,
  RESOURCE_ROUTING_MAX_SUMMARY_CHARS,
} from "../resource-routing/semantic-input.js";

describe("resource routing semantic input", () => {
  it("uses summary-only by default and trims the semantic summary", () => {
    expect(renderResourceSemanticInput("{{summary}}", {
      summary: "  Security audit report for the OpenClaw gateway.  ",
      filename: "gateway-audit.pdf",
      source: "/workspace/draft/gateway-audit.pdf",
    })).toBe("Security audit report for the OpenClaw gateway.");
  });

  it("supports explicitly configured metadata placeholders without injecting them by default", () => {
    expect(renderResourceSemanticInput("{{summary}}\nKind: {{sourceKind}}", {
      summary: "OpenViking API documentation.",
      filename: "api.md",
      sourceKind: "web",
    })).toBe("OpenViking API documentation.\nKind: web");
  });

  it("rejects an empty summary", () => {
    expect(() => requireResourceSemanticSummary("   ")).toThrow(/requires `summary`/);
  });

  it("rejects an oversized summary before any ML request", () => {
    expect(() => requireResourceSemanticSummary("x".repeat(RESOURCE_ROUTING_MAX_SUMMARY_CHARS + 1)))
      .toThrow(new RegExp(`at most ${RESOURCE_ROUTING_MAX_SUMMARY_CHARS} characters`));
  });
});
