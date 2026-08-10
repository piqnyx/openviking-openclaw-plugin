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
const agentId = "smoke";

const config = parseResourceRoutingConfig({
  enabled: true,
  taxonomyFile: taxonomyFile.replace("default-resource-taxonomy.yaml", "{agentId}.yaml"),
  cacheFile,
  audit: { enabled: false, file: join(tmpdir(), "openviking-resource-routing-calibrate-{agentId}.jsonl") },
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
  ["documents_guides", "documents-guides", "A short step-by-step how-to guide showing users how to configure a feature and complete a specific task."],
  ["documents_manuals", "documents-manuals", "A comprehensive product manual covering installation, operation, maintenance, troubleshooting, and all major features."],
  ["documents_api", "documents-api", "Human-readable API documentation listing endpoints, request parameters, authentication rules, response fields, and integration examples."],
  ["documents_reports", "documents-reports", "A written analytical report summarizing findings, conclusions, evidence, and recommendations from an assessment."],
  ["code_scripts", "code-scripts", "A Bash automation script that checks service health, rotates files, and restarts a process when needed."],
  ["code_configuration", "code-configuration", "A machine-readable YAML configuration file defining service settings, ports, feature flags, and runtime parameters."],
  ["code_patches", "code-patches", "A Git patch containing a unified diff with source-code additions and deletions for a bug fix."],
  ["web_articles", "web-articles", "A saved online blog article discussing a technical topic, preserved from a public website for later reading."],
  ["web_documentation", "web-documentation", "Pages imported directly from an online documentation portal explaining a software product and its commands."],
  ["media_screenshot", "media-images-screenshots", "A screenshot of a Linux terminal showing command output, service status, and diagnostic messages."],
  ["media_speech", "media-audio-speech", "A recorded voice message containing spoken discussion and narration with no music."],
  ["media_video_tutorial", "media-video-tutorials", "An instructional screen-recording video demonstrating step by step how to configure and use an application."],
  ["data_json", "data-structured-json", "A JSON dataset containing thousands of structured records for later analysis; it is data, not application configuration."],
  ["data_logs", "data-logs", "Runtime application logs containing timestamps, warnings, request events, stack traces, and diagnostic messages."],
  ["data_dumps", "data-dumps", "A PostgreSQL database dump containing a bulk snapshot of database schema and stored records."],
  ["reference_standard", "reference-standards", "A published industry standard containing normative requirements and compliance rules used as long-term reference."],
  ["reference_technical", "reference-technical", "A reusable engineering cheat sheet containing command syntax, protocol facts, and concise technical lookup information."],
  ["communications_email", "communications-email", "An exported email thread containing correspondence between several people about a work decision."],
  ["communications_chat", "communications-chats", "An exported messenger chat log containing chronological text messages between participants."],
  ["communications_transcript", "communications-transcripts", "A transcript of a recorded meeting containing speaker turns, discussion, questions, and decisions."],
  ["operations_procedure", "operations-procedures", "A production runbook with a repeatable operating procedure for restarting a service and verifying recovery."],
  ["operations_incident", "operations-incidents", "An outage postmortem describing an operational incident, timeline, root cause, recovery actions, and follow-up work."],
  ["security_audit", "security-audits", "A penetration-test security audit containing vulnerabilities, severity ratings, evidence, and remediation tracking."],
  ["security_hardening", "security-hardening", "A secure-configuration hardening guide listing defensive settings and practices for a Linux server."],
  ["tests_fixture", "tests-fixtures", "A reusable synthetic fixture file intentionally kept for automated integration tests."],
  ["tests_text", "tests-text", "A tiny throwaway text file with a joke created only to manually test resource importing and retrieval."],
  ["inbox_unknown", "inbox", "Miscellaneous material with no clear subject, purpose, project, or reusable reference value."],
];

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

try {
  const taxonomy = loadResourceTaxonomyFile(taxonomyFile);
  const embedder = new ResourceRoutingEmbeddingClient(config.embedding);
  const reranker = new ResourceRoutingRerankerClient(config.reranker);
  const embeddings = await buildResourceRoutingEmbeddingState({ taxonomy, agentId, config, embedder });
  const router = new ResourceRouter({ taxonomy, config, embeddings, embedder, reranker });

  const failures = [];
  let reranked = 0;
  let fallbackCount = 0;
  let totalMs = 0;

  for (const [name, expected, summary] of cases) {
    const decision = await router.route(summary);
    totalMs += decision.timing.totalMs;
    if (decision.rerankerUsed) reranked += 1;
    if (decision.fallback) fallbackCount += 1;
    if (decision.categoryKey !== expected) {
      failures.push({
        case: name,
        expected,
        selected: decision.categoryKey,
        fallback: decision.fallback,
        candidates: decision.embeddingCandidates.map(({ key, score }) => ({ key, score: round(score) })),
        rerankerUsed: decision.rerankerUsed,
        rerankerScores: decision.rerankerScores?.map(({ key, score }) => ({ key, score: round(score) })) ?? null,
      });
    }
  }

  console.log(JSON.stringify({
    cases: cases.length,
    passed: cases.length - failures.length,
    failed: failures.length,
    accuracy: round((cases.length - failures.length) / cases.length),
    reranked,
    fallbackCount,
    embeddingState: embeddings.source,
    averageRouteMs: Math.round((totalMs / cases.length) * 10) / 10,
  }));
  for (const failure of failures) {
    console.log(JSON.stringify(failure));
  }
  if (failures.length > 0) {
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}
