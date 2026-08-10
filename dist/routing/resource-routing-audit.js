import { createHash } from "node:crypto";
import { closeSync, fchmodSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
function sha256(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}
function finiteNonNegative(value) {
    if (value === undefined) {
        return undefined;
    }
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : undefined;
}
export function writeResourceRoutingAudit(input) {
    if (!input.filePath) {
        throw new Error("resource routing audit file path is required");
    }
    if (!input.agentId) {
        throw new Error("resource routing audit agentId is required");
    }
    if (input.status === "error" && !input.errorCode) {
        throw new Error("resource routing audit error records require errorCode");
    }
    const previewLimit = Number.isInteger(input.summaryPreviewChars) && input.summaryPreviewChars >= 0
        ? input.summaryPreviewChars
        : 0;
    const summaryPreview = previewLimit > 0
        ? input.summary.slice(0, previewLimit)
        : undefined;
    const decision = input.decision;
    const record = {
        timestamp: new Date().toISOString(),
        agentId: input.agentId,
        sourceHash: sha256(input.source),
        sourceKind: input.sourceKind || undefined,
        summaryHash: sha256(input.summary),
        summaryPreview,
        taxonomyHash: input.taxonomyHash,
        embeddingModel: input.embeddingModel,
        rerankerModel: input.rerankerModel,
        embeddingCandidates: decision?.embeddingCandidates.map((candidate) => ({
            key: candidate.key,
            score: candidate.score,
        })),
        rerankerUsed: decision?.rerankerUsed ?? false,
        rerankerScores: decision?.rerankerScores,
        finalCategory: decision?.categoryKey,
        fallback: decision?.fallback,
        fallbackReason: decision?.fallbackReason,
        embeddingMs: finiteNonNegative(input.timing?.embeddingMs),
        rerankerMs: finiteNonNegative(input.timing?.rerankerMs),
        totalMs: finiteNonNegative(input.timing?.totalMs),
        status: input.status,
        errorCode: input.errorCode,
    };
    mkdirSync(dirname(input.filePath), { recursive: true });
    const fd = openSync(input.filePath, "a", 0o600);
    try {
        // open(2) applies mode only when creating the file. Enforce owner-only mode
        // as well when an existing audit file was created with broader permissions.
        fchmodSync(fd, 0o600);
        writeSync(fd, `${JSON.stringify(record)}\n`, undefined, "utf8");
    }
    finally {
        closeSync(fd);
    }
}
