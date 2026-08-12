import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeResourceRoutingEmbeddingIdentity,
  loadResourceRoutingEmbeddingCache,
} from "../dist/routing/resource-routing-cache.js";
import { parseResourceRoutingConfig } from "../dist/routing/resource-routing-config.js";
import {
  ResourceRoutingEmbeddingClient,
  ResourceRoutingRerankerClient,
} from "../dist/routing/resource-routing-model-client.js";
import { ResourceRouter } from "../dist/routing/resource-router.js";
import {
  loadResourceTaxonomyFile,
  resolvePerAgentFileTemplate,
} from "../dist/routing/resource-taxonomy.js";

const DEFAULT_CONFIG_FILE = resolve(homedir(), ".openclaw", "openclaw.json");

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function nested(record, keys) {
  let current = record;
  for (const key of keys) {
    current = asRecord(current)?.[key];
  }
  return current;
}

export function extractResourceRoutingConfig(document) {
  const candidates = [
    ["plugins.entries.openviking.config.resourceRouting", ["plugins", "entries", "openviking", "config", "resourceRouting"]],
    ["plugins.openviking.config.resourceRouting", ["plugins", "openviking", "config", "resourceRouting"]],
    ["openviking.config.resourceRouting", ["openviking", "config", "resourceRouting"]],
    ["resourceRouting", ["resourceRouting"]],
  ];
  for (const [label, path] of candidates) {
    const value = nested(document, path);
    if (asRecord(value)) {
      return { source: label, value };
    }
  }
  throw new Error(
    "Could not locate OpenViking resourceRouting config. Expected plugins.entries.openviking.config.resourceRouting or an equivalent supported shape.",
  );
}

function parseNumber(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be a finite number between ${min} and ${max}`);
  }
  return parsed;
}

function parseInteger(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function parseNumberList(value, label, min, max) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} requires a comma-separated list`);
  }
  const values = value.split(",").map((entry) => parseNumber(entry.trim(), label, min, max));
  return [...new Set(values)];
}

function requireValue(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    configFile: DEFAULT_CONFIG_FILE,
    agentId: "main",
    details: "mismatches",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--verbose") {
      options.details = "all";
      continue;
    }
    if (arg === "--quiet") {
      options.details = "none";
      continue;
    }
    if (arg === "--json") {
      options.jsonStdout = true;
      continue;
    }

    const value = requireValue(argv, index, arg);
    index += 1;
    switch (arg) {
      case "--config": options.configFile = resolve(value); break;
      case "--agent": options.agentId = value.trim(); break;
      case "--cases": options.casesFile = resolve(value); break;
      case "--summary": options.summary = value; break;
      case "--expected": options.expected = value; break;
      case "--output": options.outputFile = resolve(value); break;
      case "--taxonomy": options.taxonomyFile = value; break;
      case "--cache": options.cacheFile = value; break;
      case "--top-k": options.topK = parseInteger(value, "--top-k", 1, 50); break;
      case "--min-score": options.minScore = parseNumber(value, "--min-score", -1, 1); break;
      case "--rerank-margin":
      case "--rerank-below-margin":
        options.rerankBelowMargin = parseNumber(value, arg, 0, 2);
        break;
      case "--min-scores": options.minScores = parseNumberList(value, "--min-scores", -1, 1); break;
      case "--rerank-margins": options.rerankMargins = parseNumberList(value, "--rerank-margins", 0, 2); break;
      case "--embedding-base-url": options.embeddingBaseUrl = value; break;
      case "--embedding-model": options.embeddingModel = value; break;
      case "--embedding-timeout-ms": options.embeddingTimeoutMs = parseInteger(value, arg, 100, 300_000); break;
      case "--reranker-base-url": options.rerankerBaseUrl = value; break;
      case "--reranker-model": options.rerankerModel = value; break;
      case "--reranker-timeout-ms": options.rerankerTimeoutMs = parseInteger(value, arg, 100, 300_000); break;
      case "--details":
        if (!["all", "mismatches", "none"].includes(value)) {
          throw new Error("--details must be all, mismatches, or none");
        }
        options.details = value;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.agentId) {
    throw new Error("--agent must be non-empty");
  }
  if (options.casesFile && options.summary) {
    throw new Error("Use either --cases or --summary, not both");
  }
  if (!options.help && !options.casesFile && !options.summary) {
    throw new Error("Provide --cases <file.json> or --summary <text>");
  }
  return options;
}

function normalizeExpected(value, label) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const raw = Array.isArray(value) ? value : [value];
  const expected = raw.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${label}.expected[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
  return [...new Set(expected)];
}

export function normalizeCases(value) {
  const rawCases = Array.isArray(value) ? value : asRecord(value)?.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error("Cases file must contain a non-empty JSON array or {\"cases\":[...]}");
  }
  const seen = new Set();
  return rawCases.map((entry, index) => {
    const record = asRecord(entry);
    if (!record) {
      throw new Error(`cases[${index}] must be an object`);
    }
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : `case-${index + 1}`;
    if (seen.has(id)) {
      throw new Error(`Duplicate case id: ${id}`);
    }
    seen.add(id);
    if (typeof record.summary !== "string" || !record.summary.trim()) {
      throw new Error(`cases[${index}].summary must be a non-empty string`);
    }
    return {
      id,
      summary: record.summary.trim(),
      expected: normalizeExpected(record.expected, `cases[${index}]`),
      note: typeof record.note === "string" && record.note.trim() ? record.note.trim() : undefined,
    };
  });
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyConfigOverrides(rawConfig, options) {
  const config = deepClone(rawConfig);
  config.enabled = true;
  if (options.taxonomyFile) config.taxonomyFile = options.taxonomyFile;
  if (options.cacheFile) config.cacheFile = options.cacheFile;

  config.embedding = asRecord(config.embedding) ?? {};
  if (options.embeddingBaseUrl) config.embedding.baseUrl = options.embeddingBaseUrl;
  if (options.embeddingModel) config.embedding.model = options.embeddingModel;
  if (options.embeddingTimeoutMs !== undefined) config.embedding.timeoutMs = options.embeddingTimeoutMs;

  config.reranker = asRecord(config.reranker) ?? {};
  if (options.rerankerBaseUrl) config.reranker.baseUrl = options.rerankerBaseUrl;
  if (options.rerankerModel) config.reranker.model = options.rerankerModel;
  if (options.rerankerTimeoutMs !== undefined) config.reranker.timeoutMs = options.rerankerTimeoutMs;

  config.retrieval = asRecord(config.retrieval) ?? {};
  if (options.topK !== undefined) config.retrieval.topK = options.topK;
  if (options.minScore !== undefined) config.retrieval.minScore = options.minScore;
  if (options.rerankBelowMargin !== undefined) config.retrieval.rerankBelowMargin = options.rerankBelowMargin;
  return config;
}

export function buildProfiles(baseConfig, options) {
  const minScores = options.minScores ?? [baseConfig.retrieval.minScore];
  const margins = options.rerankMargins ?? [baseConfig.retrieval.rerankBelowMargin];
  const profiles = [];
  for (const minScore of minScores) {
    for (const rerankBelowMargin of margins) {
      profiles.push({
        topK: baseConfig.retrieval.topK,
        minScore,
        rerankBelowMargin,
      });
    }
  }
  return profiles;
}

function readJson(filePath, label) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} could not be read at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateExpectedCategories(cases, taxonomy) {
  for (const testCase of cases) {
    for (const key of testCase.expected ?? []) {
      const category = taxonomy.byKey.get(key);
      if (!category || !category.routeable) {
        throw new Error(`Case ${JSON.stringify(testCase.id)} expects unknown/non-routeable taxonomy key ${JSON.stringify(key)}`);
      }
    }
  }
}

function loadValidatedCache(config, taxonomy, agentId) {
  const cacheFile = resolvePerAgentFileTemplate(config.cacheFile, agentId);
  const expected = {
    taxonomyHash: taxonomy.taxonomyHash,
    embeddingModel: config.embedding.model,
    embeddingIdentity: computeResourceRoutingEmbeddingIdentity({
      baseUrl: config.embedding.baseUrl,
      model: config.embedding.model,
      apiKey: config.embedding.apiKey,
      headers: config.embedding.headers,
    }),
    dimensions: config.embedding.dimensions,
    categoryKeys: taxonomy.semanticCategories.map((category) => category.key),
  };
  const loaded = loadResourceRoutingEmbeddingCache(cacheFile, expected);
  if (!loaded.hit) {
    throw new Error(
      `Routing probe is read-only and requires a valid existing semantic category cache. Cache miss at ${cacheFile}: ${loaded.reason}. ` +
      "Build the cache through gateway startup first; the probe will never rebuild or modify it.",
    );
  }
  return { cacheFile, cache: loaded.cache };
}

function embeddingStateFromCache(taxonomy, cache) {
  const vectors = new Map(cache.categories.map((entry) => [entry.key, entry.embedding]));
  return {
    source: "cache",
    categories: taxonomy.semanticCategories.map((category) => {
      const embedding = vectors.get(category.key);
      if (!embedding) {
        throw new Error(`Validated cache unexpectedly lacks category ${JSON.stringify(category.key)}`);
      }
      return {
        key: category.key,
        path: category.path,
        routingText: category.routingText,
        embedding,
      };
    }),
  };
}

function createRouter(config, taxonomy, embeddingState, profile) {
  const profileConfig = {
    ...config,
    retrieval: {
      topK: profile.topK,
      minScore: profile.minScore,
      rerankBelowMargin: profile.rerankBelowMargin,
    },
  };
  return new ResourceRouter({
    taxonomy,
    config: profileConfig,
    embeddings: embeddingState,
    embedder: new ResourceRoutingEmbeddingClient(profileConfig.embedding),
    reranker: new ResourceRoutingRerankerClient(profileConfig.reranker),
  });
}

function round(value, digits = 6) {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return undefined;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function profileId(profile) {
  return `k${profile.topK}-min${profile.minScore}-margin${profile.rerankBelowMargin}`;
}

function expectedMatches(expected, actual) {
  return expected ? expected.includes(actual) : undefined;
}

function summarizeProfile(profile, rows, fallbackKey) {
  const labeled = rows.filter((row) => row.correct !== undefined);
  const correct = labeled.filter((row) => row.correct).length;
  const falseInbox = labeled.filter((row) => row.actual === fallbackKey && !row.expected.includes(fallbackKey)).length;
  const missedInbox = labeled.filter(
    (row) => row.actual !== fallbackKey && row.expected.length === 1 && row.expected[0] === fallbackKey,
  ).length;
  return {
    id: profileId(profile),
    ...profile,
    cases: rows.length,
    labeled: labeled.length,
    correct,
    wrong: labeled.length - correct,
    accuracy: labeled.length ? round(correct / labeled.length, 4) : undefined,
    fallbackCount: rows.filter((row) => row.fallback).length,
    falseInbox,
    missedInbox,
    rerankerCount: rows.filter((row) => row.rerankerUsed).length,
    avgEmbeddingMs: round(mean(rows.map((row) => row.timing.embeddingMs)), 2),
    avgRerankerMs: round(mean(rows.map((row) => row.timing.rerankerMs)), 2),
    avgTotalMs: round(mean(rows.map((row) => row.timing.totalMs)), 2),
  };
}

export function rankProfileSummaries(summaries) {
  return [...summaries].sort((left, right) => {
    const leftAccuracy = left.accuracy ?? -1;
    const rightAccuracy = right.accuracy ?? -1;
    return (
      rightAccuracy - leftAccuracy ||
      left.wrong - right.wrong ||
      left.falseInbox - right.falseInbox ||
      left.missedInbox - right.missedInbox ||
      left.rerankerCount - right.rerankerCount ||
      left.minScore - right.minScore ||
      left.rerankBelowMargin - right.rerankBelowMargin
    );
  });
}

async function runProfile(config, taxonomy, embeddingState, profile, cases) {
  const router = createRouter(config, taxonomy, embeddingState, profile);
  const rows = [];
  for (const testCase of cases) {
    const decision = await router.route(testCase.summary);
    const top1 = decision.embeddingCandidates[0];
    const top2 = decision.embeddingCandidates[1];
    const selected = taxonomy.byKey.get(decision.categoryKey);
    rows.push({
      id: testCase.id,
      summary: testCase.summary,
      note: testCase.note,
      expected: testCase.expected,
      actual: decision.categoryKey,
      actualPath: selected?.path,
      correct: expectedMatches(testCase.expected, decision.categoryKey),
      fallback: decision.fallback,
      fallbackReason: decision.fallbackReason,
      rerankerUsed: decision.rerankerUsed,
      top1Score: round(top1?.score),
      top2Score: round(top2?.score),
      top12Gap: top1 && top2 ? round(top1.score - top2.score) : undefined,
      embeddingCandidates: decision.embeddingCandidates.map((candidate) => ({
        key: candidate.key,
        path: candidate.path,
        score: round(candidate.score),
      })),
      rerankerScores: decision.rerankerScores?.map((entry) => ({
        key: entry.key,
        path: entry.path,
        score: round(entry.score),
      })),
      timing: {
        embeddingMs: round(decision.timing.embeddingMs, 2),
        rerankerMs: round(decision.timing.rerankerMs, 2),
        totalMs: round(decision.timing.totalMs, 2),
      },
    });
  }
  return rows;
}

function printProfileSummary(summary, marker = "") {
  const accuracy = summary.accuracy === undefined ? "n/a" : `${(summary.accuracy * 100).toFixed(1)}%`;
  console.log(
    `${marker}${summary.id} accuracy=${accuracy} correct=${summary.correct}/${summary.labeled} ` +
    `wrong=${summary.wrong} falseInbox=${summary.falseInbox} missedInbox=${summary.missedInbox} ` +
    `reranker=${summary.rerankerCount}/${summary.cases} avg=${summary.avgTotalMs ?? "n/a"}ms`,
  );
}

function printCaseRows(rows, details) {
  if (details === "none") return;
  const selected = details === "all" ? rows : rows.filter((row) => row.correct === false);
  for (const row of selected) {
    const expected = row.expected?.join("|") ?? "(unlabeled)";
    const mark = row.correct === true ? "OK" : row.correct === false ? "MISS" : "INFO";
    console.log(
      `${mark} ${row.id}: expected=${expected} actual=${row.actual} path=${row.actualPath ?? "n/a"} ` +
      `top1=${row.top1Score ?? "n/a"} gap=${row.top12Gap ?? "n/a"} rerank=${row.rerankerUsed ? "yes" : "no"}`,
    );
    if (row.rerankerUsed && row.rerankerScores) {
      console.log(
        `  reranker: ${row.rerankerScores.map((entry) => `${entry.key}[${entry.path}]=${entry.score}`).join(" ")}`,
      );
    }
    console.log(
      `  cosine: ${row.embeddingCandidates.map((entry) => `${entry.key}[${entry.path}]=${entry.score}`).join(" ")}`,
    );
  }
}

function usage() {
  return `Usage:
  npm run routing:probe -- --agent main --cases /path/cases.json
  npm run routing:probe -- --agent main --summary "semantic summary" [--expected category]

The probe is READ-ONLY. It uses the exact production taxonomy compiler, semantic-category
cache, embedding query and reranker logic. It never rebuilds cache and never imports,
moves or deletes OpenViking resources.

Threshold overrides:
  --min-score 0.57
  --rerank-margin 0.06
  --top-k 3

Sweep grids:
  --min-scores 0.45,0.50,0.55,0.57,0.60,0.65
  --rerank-margins 0.00,0.03,0.06,0.10

Input/output:
  --config /home/openclaw/.openclaw/openclaw.json
  --cases /home/openclaw/routing-cases.json
  --output /home/openclaw/routing-probe-result.json
  --details all|mismatches|none
  --verbose
  --quiet
  --json

Advanced endpoint/path overrides:
  --taxonomy PATH_TEMPLATE
  --cache PATH_TEMPLATE
  --embedding-base-url URL
  --embedding-model MODEL
  --embedding-timeout-ms MS
  --reranker-base-url URL
  --reranker-model MODEL
  --reranker-timeout-ms MS
`;
}

export async function runProbe(options) {
  const configDocument = readJson(options.configFile, "OpenClaw config");
  const extracted = extractResourceRoutingConfig(configDocument);
  const rawRoutingConfig = applyConfigOverrides(extracted.value, options);
  const config = parseResourceRoutingConfig(rawRoutingConfig);
  const taxonomyFile = resolvePerAgentFileTemplate(config.taxonomyFile, options.agentId);
  const taxonomy = loadResourceTaxonomyFile(taxonomyFile);

  const cases = options.casesFile
    ? normalizeCases(readJson(options.casesFile, "Routing cases"))
    : normalizeCases([{ id: "single", summary: options.summary, expected: options.expected }]);
  validateExpectedCategories(cases, taxonomy);

  const { cacheFile, cache } = loadValidatedCache(config, taxonomy, options.agentId);
  const embeddingState = embeddingStateFromCache(taxonomy, cache);
  const profiles = buildProfiles(config, options);
  if (profiles.length > 100) {
    throw new Error(`Refusing ${profiles.length} threshold profiles in one run; use a smaller grid (max 100)`);
  }

  const profileResults = [];
  for (const profile of profiles) {
    const rows = await runProfile(config, taxonomy, embeddingState, profile, cases);
    const summary = summarizeProfile(profile, rows, config.fallbackCategory);
    profileResults.push({ profile, summary, cases: rows });
  }
  const ranking = rankProfileSummaries(profileResults.map((entry) => entry.summary));

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    config: {
      file: options.configFile,
      source: extracted.source,
      agentId: options.agentId,
      taxonomyFile,
      cacheFile,
      taxonomyHash: taxonomy.taxonomyHash,
      totalCategories: taxonomy.categories.length,
      routeableCategories: taxonomy.routeableCategories.length,
      semanticCategories: taxonomy.semanticCategories.length,
      embedding: {
        baseUrl: config.embedding.baseUrl,
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
        timeoutMs: config.embedding.timeoutMs,
      },
      reranker: {
        baseUrl: config.reranker.baseUrl,
        model: config.reranker.model,
        timeoutMs: config.reranker.timeoutMs,
      },
      fallbackCategory: config.fallbackCategory,
      fallbackPath: taxonomy.byKey.get(config.fallbackCategory)?.path,
      baseRetrieval: config.retrieval,
    },
    cases: cases.length,
    profiles: profileResults,
    ranking,
    best: ranking[0],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const result = await runProbe(options);
  if (options.outputFile) {
    writeFileSync(options.outputFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  if (options.jsonStdout) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  console.log(`routing probe: READ-ONLY; agent=${result.config.agentId}`);
  console.log(`taxonomy: ${result.config.taxonomyFile}`);
  console.log(
    `cache: ${result.config.cacheFile} (${result.config.semanticCategories} semantic / ` +
    `${result.config.routeableCategories} routeable / ${result.config.totalCategories} total, valid hit)`,
  );
  console.log(`embedder: ${result.config.embedding.model} @ ${result.config.embedding.baseUrl}`);
  console.log(`reranker: ${result.config.reranker.model} @ ${result.config.reranker.baseUrl}`);
  console.log(`fallback: ${result.config.fallbackCategory}[${result.config.fallbackPath ?? "n/a"}]`);
  console.log(`cases=${result.cases} profiles=${result.profiles.length}`);
  if (options.outputFile) console.log(`full JSON: ${options.outputFile}`);
  console.log("");

  for (const entry of result.profiles) {
    printProfileSummary(entry.summary);
    printCaseRows(entry.cases, options.details);
  }

  if (result.profiles.length > 1) {
    console.log("\n=== ranking ===");
    result.ranking.forEach((summary, index) => {
      printProfileSummary(summary, index === 0 ? "BEST " : `${index + 1}. `);
    });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(`routing probe failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
