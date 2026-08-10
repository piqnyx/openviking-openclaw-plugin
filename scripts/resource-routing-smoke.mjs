import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseResourceRoutingConfig } from "../dist/routing/resource-routing-config.js";
import {
  ResourceRoutingEmbeddingClient,
  ResourceRoutingRerankerClient,
} from "../dist/routing/resource-routing-model-client.js";
import {
  buildResourceRoutingEmbeddingState,
  ResourceRouter,
} from "../dist/routing/resource-router.js";
import { loadResourceTaxonomyFile } from "../dist/routing/resource-taxonomy.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const taxonomyFile = join(repoRoot, "routing", "default-resource-taxonomy.yaml");
const cacheFile = join(tmpdir(), "openviking-resource-routing-smoke-{agentId}.json");
const auditFile = join(tmpdir(), "openviking-resource-routing-smoke-{agentId}.jsonl");
const agentId = "smoke";

const config = parseResourceRoutingConfig({
  enabled: true,
  taxonomyFile: taxonomyFile.replace("default-resource-taxonomy.yaml", "{agentId}.yaml"),
  cacheFile,
  audit: { enabled: false, file: auditFile },
  embedding: {
    baseUrl: process.env.OV_ROUTING_EMBED_BASE_URL ?? "http://127.0.0.1:18081",
    model: process.env.OV_ROUTING_EMBED_MODEL ?? "bge-m3",
    dimensions: Number(process.env.OV_ROUTING_EMBED_DIMENSIONS ?? 1024),
    timeoutMs: Number(process.env.OV_ROUTING_EMBED_TIMEOUT_MS ?? 10_000),
  },
  reranker: {
    baseUrl: process.env.OV_ROUTING_RERANK_BASE_URL ?? "http://127.0.0.1:18080",
    model: process.env.OV_ROUTING_RERANK_MODEL ?? "bge-reranker-v2-m3",
    timeoutMs: Number(process.env.OV_ROUTING_RERANK_TIMEOUT_MS ?? 10_000),
  },
  retrieval: {
    topK: Number(process.env.OV_ROUTING_TOP_K ?? 2),
    minScore: Number(process.env.OV_ROUTING_MIN_SCORE ?? 0.64),
    rerankBelowMargin: Number(process.env.OV_ROUTING_RERANK_MARGIN ?? 0.06),
  },
  fallbackCategory: "inbox",
});

const cases = [
  ["openclaw_guide", "A technical guide explaining how to configure, operate, and troubleshoot OpenClaw."],
  ["security_audit", "A security audit report containing findings, risk analysis, and remediation recommendations."],
  ["terminal_screenshot", "A terminal screenshot showing Linux service status, command output, and diagnostic logs."],
  ["test_joke", "A small throwaway joke text created only to test resource importing and retrieval."],
  ["unknown", "Miscellaneous material with no clear subject, purpose, project, or reusable reference value."],
];

try {
  if (process.argv.includes("--fresh")) {
    rmSync(cacheFile.replace("{agentId}", agentId), { force: true });
  }

  const taxonomy = loadResourceTaxonomyFile(taxonomyFile);
  const embedder = new ResourceRoutingEmbeddingClient(config.embedding);
  const reranker = new ResourceRoutingRerankerClient(config.reranker);
  const started = performance.now();
  const embeddings = await buildResourceRoutingEmbeddingState({
    taxonomy,
    agentId,
    config,
    embedder,
  });
  const startupMs = performance.now() - started;
  const router = new ResourceRouter({ taxonomy, config, embeddings, embedder, reranker });

  console.log(JSON.stringify({
    taxonomyCategories: taxonomy.categories.length,
    routeableCategories: taxonomy.routeableCategories.length,
    taxonomyHash: taxonomy.taxonomyHash,
    embeddingState: embeddings.source,
    cacheMissReason: embeddings.cacheMissReason ?? null,
    startupMs: Math.round(startupMs * 10) / 10,
  }));

  for (const [name, summary] of cases) {
    const decision = await router.route(summary);
    console.log(JSON.stringify({
      case: name,
      selected: decision.categoryKey,
      uri: decision.uri,
      fallback: decision.fallback,
      fallbackReason: decision.fallbackReason ?? null,
      candidates: decision.embeddingCandidates.map(({ key, score }) => ({
        key,
        score: Math.round(score * 10_000) / 10_000,
      })),
      rerankerUsed: decision.rerankerUsed,
      rerankerScores: decision.rerankerScores?.map(({ key, score }) => ({
        key,
        score: Math.round(score * 10_000) / 10_000,
      })) ?? null,
      timing: {
        embeddingMs: Math.round(decision.timing.embeddingMs * 10) / 10,
        rerankerMs: decision.timing.rerankerMs === undefined
          ? null
          : Math.round(decision.timing.rerankerMs * 10) / 10,
        totalMs: Math.round(decision.timing.totalMs * 10) / 10,
      },
    }));
  }
} catch (error) {
  console.error(JSON.stringify({
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}
