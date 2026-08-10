import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendResourceRoutingAudit,
  createResourceRoutingAuditRecord,
  resourceRoutingAuditHash,
} from "../resource-routing/audit.js";

describe("resource routing audit", () => {
  it("hashes source and summary by default instead of persisting raw provenance", () => {
    const record = createResourceRoutingAuditRecord({
      agentId: "main",
      source: "/workspace/draft/private-name.md",
      summary: "A private semantic description.",
      includeSummaryPreview: false,
      summaryPreviewChars: 240,
      taxonomyHash: "tax-hash",
      embeddingModel: "bge-m3@http://127.0.0.1:18081/v1/embeddings",
      decision: {
        categoryKey: "docs",
        categoryUri: "viking://resources/documents",
        fallback: false,
        embeddingTop: [{ key: "docs", uri: "viking://resources/documents", score: 0.91 }],
        rerankerUsed: false,
        timingMs: { embedding: 82, total: 84 },
      },
      outcome: "success",
      timestamp: new Date("2026-08-10T07:00:00.000Z"),
    });

    expect(record.sourceHash).toBe(resourceRoutingAuditHash("/workspace/draft/private-name.md"));
    expect(record.summaryHash).toBe(resourceRoutingAuditHash("A private semantic description."));
    expect(record).not.toHaveProperty("summaryPreview");
    expect(JSON.stringify(record)).not.toContain("private-name.md");
    expect(JSON.stringify(record)).not.toContain("private semantic description");
    expect(record.timingMs).toEqual({ embedding: 82, total: 84 });
  });

  it("includes only a bounded summary preview when explicitly configured", () => {
    const record = createResourceRoutingAuditRecord({
      agentId: "main",
      source: "https://example.test/doc",
      summary: "1234567890",
      includeSummaryPreview: true,
      summaryPreviewChars: 5,
      outcome: "error",
      errorCode: "routing_infrastructure_error",
      errorMessage: "embedder unavailable",
    });
    expect(record.summaryPreview).toBe("12345");
    expect(record.outcome).toBe("error");
  });

  it("appends one private JSON object per line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ov-routing-audit-"));
    const file = join(dir, "main.jsonl");
    const first = createResourceRoutingAuditRecord({
      agentId: "main",
      source: "a",
      summary: "first",
      includeSummaryPreview: false,
      summaryPreviewChars: 240,
      outcome: "success",
    });
    const second = createResourceRoutingAuditRecord({
      agentId: "main",
      source: "b",
      summary: "second",
      includeSummaryPreview: false,
      summaryPreviewChars: 240,
      outcome: "error",
      errorCode: "routing_infrastructure_error",
    });
    await appendResourceRoutingAudit(file, first);
    await appendResourceRoutingAudit(file, second);
    const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.map((entry) => entry.outcome)).toEqual(["success", "error"]);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });
});
