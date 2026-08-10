import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeResourceRoutingAudit } from "../routing/resource-routing-audit.js";
import { renderResourceRoutingSemanticInput } from "../routing/resource-routing-semantic-input.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resource routing semantic input", () => {
  it("uses summary-only by default and supports explicitly configured metadata", () => {
    const context = {
      summary: "A security audit report covering findings and remediation.",
      filename: "audit-2026.pdf",
      sourceKind: "local_file",
    };
    expect(renderResourceRoutingSemanticInput("{{summary}}", context))
      .toBe(context.summary);
    expect(renderResourceRoutingSemanticInput(
      "{{summary}}\nSource type: {{sourceKind}}\nFilename: {{filename}}",
      context,
    )).toContain("Source type: local_file");
  });

  it("returns an actionable tool-facing error when summary is missing", () => {
    expect(() => renderResourceRoutingSemanticInput("{{summary}}", { summary: "" }))
      .toThrow(/Automatic resource routing requires `summary`/);
  });

  it("fails closed on unknown template fields", () => {
    expect(() => renderResourceRoutingSemanticInput("{{summary}} {{magic}}", { summary: "x" }))
      .toThrow(/unknown field "magic"/);
  });
});

describe("resource routing audit", () => {
  it("writes compact JSONL with hashes, bounded preview and decision evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-routing-audit-"));
    tempDirs.push(dir);
    const filePath = join(dir, "nested", "main.jsonl");
    const timing = { embeddingMs: 82.1234, rerankerMs: 373.9876, totalMs: 460.1111 };
    writeResourceRoutingAudit({
      filePath,
      agentId: "main",
      source: "/workspace/private/audit.pdf",
      sourceKind: "local_file",
      summary: "A security audit report with findings and remediation steps.",
      summaryPreviewChars: 12,
      taxonomyHash: "tax-hash",
      embeddingModel: "bge-m3",
      rerankerModel: "bge-reranker-v2-m3",
      decision: {
        categoryKey: "security_audits",
        uri: "viking://resources/security/audits",
        fallback: false,
        embeddingCandidates: [
          { key: "security", description: "Security", score: 0.8 },
          { key: "security_audits", description: "Audits", score: 0.79 },
        ],
        rerankerUsed: true,
        rerankerScores: [
          { key: "security_audits", score: 0.94 },
          { key: "security", score: 0.71 },
        ],
        timing,
      },
      timing,
      status: "success",
    });

    const [line] = readFileSync(filePath, "utf8").trim().split("\n");
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record).not.toHaveProperty("source");
    expect(record.summaryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.summaryPreview).toBe("A security a");
    expect(record.finalCategory).toBe("security_audits");
    expect(record.rerankerUsed).toBe(true);
    expect(record.embeddingMs).toBe(82.123);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("requires an explicit error code for infrastructure failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-routing-audit-"));
    tempDirs.push(dir);
    expect(() => writeResourceRoutingAudit({
      filePath: join(dir, "main.jsonl"),
      agentId: "main",
      source: "/workspace/a",
      summary: "summary",
      summaryPreviewChars: 0,
      taxonomyHash: "tax-hash",
      embeddingModel: "bge-m3",
      rerankerModel: "bge-reranker-v2-m3",
      status: "error",
    })).toThrow(/require errorCode/);
  });
});