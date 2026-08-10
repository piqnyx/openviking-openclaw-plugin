import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { ResourceRoutingDecision } from "./decision.js";

export type ResourceRoutingAuditRecord = {
  schemaVersion: 1;
  timestamp: string;
  agentId: string;
  sourceHash: string;
  summaryHash: string;
  summaryPreview?: string;
  taxonomyHash?: string;
  embeddingModel?: string;
  embeddingTop?: ResourceRoutingDecision["embeddingTop"];
  rerankerUsed?: boolean;
  rerankerScores?: ResourceRoutingDecision["rerankerScores"];
  finalCategory?: string;
  fallback?: boolean;
  fallbackReason?: string;
  timingMs?: {
    embedding?: number;
    reranker?: number;
    total?: number;
  };
  outcome: "success" | "error";
  errorCode?: string;
  errorMessage?: string;
};

export function resourceRoutingAuditHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createResourceRoutingAuditRecord(options: {
  agentId: string;
  source: string;
  summary: string;
  includeSummaryPreview: boolean;
  summaryPreviewChars: number;
  taxonomyHash?: string;
  embeddingModel?: string;
  decision?: ResourceRoutingDecision;
  outcome: "success" | "error";
  errorCode?: string;
  errorMessage?: string;
  timestamp?: Date;
}): ResourceRoutingAuditRecord {
  const summary = options.summary.trim();
  const decision = options.decision;
  return {
    schemaVersion: 1,
    timestamp: (options.timestamp ?? new Date()).toISOString(),
    agentId: options.agentId,
    sourceHash: resourceRoutingAuditHash(options.source),
    summaryHash: resourceRoutingAuditHash(summary),
    ...(options.includeSummaryPreview
      ? { summaryPreview: summary.slice(0, options.summaryPreviewChars) }
      : {}),
    taxonomyHash: options.taxonomyHash,
    embeddingModel: options.embeddingModel,
    embeddingTop: decision?.embeddingTop,
    rerankerUsed: decision?.rerankerUsed,
    rerankerScores: decision?.rerankerScores,
    finalCategory: decision?.categoryKey,
    fallback: decision?.fallback,
    fallbackReason: decision?.fallbackReason,
    timingMs: decision?.timingMs,
    outcome: options.outcome,
    errorCode: options.errorCode,
    errorMessage: options.errorMessage,
  };
}

export async function appendResourceRoutingAudit(
  filePath: string,
  record: ResourceRoutingAuditRecord,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  // `mode` only controls creation. Harden an existing file too, because an
  // operator may enable bounded summary previews in this audit stream.
  if (process.platform !== "win32") {
    await chmod(filePath, 0o600);
  }
}
