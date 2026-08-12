import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeResourceRoutingEmbeddingIdentity,
  loadResourceRoutingEmbeddingCache,
} from "../dist/routing/resource-routing-cache.js";
import { parseResourceRoutingConfig } from "../dist/routing/resource-routing-config.js";
import { cosineSimilarity } from "../dist/routing/resource-routing-retrieval.js";
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

function extractRoutingConfig(document) {
  const paths = [
    ["plugins", "entries", "openviking", "config", "resourceRouting"],
    ["plugins", "openviking", "config", "resourceRouting"],
    ["openviking", "config", "resourceRouting"],
    ["resourceRouting"],
  ];
  for (const path of paths) {
    const value = nested(document, path);
    if (asRecord(value)) return value;
  }
  throw new Error("Could not locate OpenViking resourceRouting config");
}

function requireValue(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseAuditArgs(argv) {
  const options = {
    configFile: DEFAULT_CONFIG_FILE,
    agentId: "main",
    top: 30,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const value = requireValue(argv, index, arg);
    index += 1;
    switch (arg) {
      case "--config": options.configFile = resolve(value); break;
      case "--agent": options.agentId = value.trim(); break;
      case "--taxonomy": options.taxonomyFile = resolve(value); break;
      case "--cache": options.cacheFile = resolve(value); break;
      case "--language":
        if (!["auto", "ru", "any"].includes(value)) {
          throw new Error("--language must be auto, ru, or any");
        }
        options.language = value;
        break;
      case "--top": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
          throw new Error("--top must be an integer between 1 and 500");
        }
        options.top = parsed;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.agentId) throw new Error("--agent must be non-empty");
  return options;
}

export function normalizeDescription(text) {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("ru")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordTokens(text) {
  return new Set(
    normalizeDescription(text)
      .split(" ")
      .filter((token) => token.length >= 3),
  );
}

export function tokenJaccard(left, right) {
  const a = left instanceof Set ? left : wordTokens(left);
  const b = right instanceof Set ? right : wordTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

function cyrillicStats(text) {
  let letters = 0;
  let cyrillic = 0;
  for (const char of text.normalize("NFC")) {
    if (/\p{L}/u.test(char)) {
      letters += 1;
      if (/[А-Яа-яЁё]/u.test(char)) cyrillic += 1;
    }
  }
  return {
    letters,
    cyrillic,
    ratio: letters ? cyrillic / letters : 0,
  };
}

function detectLanguage(taxonomy) {
  if (taxonomy.categories.length === 0) return "any";
  const withCyrillic = taxonomy.categories.filter((category) => cyrillicStats(category.description).cyrillic >= 4).length;
  return withCyrillic / taxonomy.categories.length >= 0.8 ? "ru" : "any";
}

function exactDuplicateGroups(categories) {
  const groups = new Map();
  for (const category of categories) {
    const normalized = normalizeDescription(category.description);
    const entries = groups.get(normalized) ?? [];
    entries.push(category);
    groups.set(normalized, entries);
  }
  return [...groups.entries()]
    .filter(([normalized, entries]) => normalized && entries.length > 1)
    .map(([normalized, entries]) => ({
      normalized,
      categories: entries.map(({ key, path, description }) => ({ key, path, description })),
    }));
}

function repeatedSegments(categories) {
  const groups = new Map();
  for (const category of categories) {
    const entries = groups.get(category.segment) ?? [];
    entries.push(category);
    groups.set(category.segment, entries);
  }
  return [...groups.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([segment, entries]) => ({
      segment,
      categories: entries.map(({ key, path, routeable }) => ({ key, path, routeable })),
    }))
    .sort((a, b) => b.categories.length - a.categories.length || a.segment.localeCompare(b.segment));
}

function lexicalNearPairs(categories, top) {
  const prepared = categories.map((category) => ({
    category,
    tokens: wordTokens(category.description),
  }));
  const pairs = [];
  for (let left = 0; left < prepared.length; left += 1) {
    for (let right = left + 1; right < prepared.length; right += 1) {
      const a = prepared[left];
      const b = prepared[right];
      let shared = 0;
      for (const token of a.tokens) {
        if (b.tokens.has(token)) shared += 1;
      }
      if (shared < 3) continue;
      const score = tokenJaccard(a.tokens, b.tokens);
      if (score < 0.45) continue;
      pairs.push({
        score,
        sharedTokens: shared,
        sameParent: a.category.parentKey === b.category.parentKey,
        left: {
          key: a.category.key,
          path: a.category.path,
          description: a.category.description,
        },
        right: {
          key: b.category.key,
          path: b.category.path,
          description: b.category.description,
        },
      });
    }
  }
  return pairs
    .sort((a, b) => b.score - a.score || b.sharedTokens - a.sharedTokens || a.left.path.localeCompare(b.left.path))
    .slice(0, top);
}

function embeddingNearPairs(taxonomy, cache, top) {
  if (!cache) return [];
  const vectors = new Map(cache.categories.map((entry) => [entry.key, entry.embedding]));
  const categories = taxonomy.semanticCategories;
  const pairs = [];
  for (let left = 0; left < categories.length; left += 1) {
    const a = categories[left];
    const va = vectors.get(a.key);
    if (!va) continue;
    for (let right = left + 1; right < categories.length; right += 1) {
      const b = categories[right];
      const vb = vectors.get(b.key);
      if (!vb) continue;
      const score = cosineSimilarity(va, vb);
      pairs.push({
        score,
        sameParent: a.parentKey === b.parentKey,
        left: { key: a.key, path: a.path, description: a.description },
        right: { key: b.key, path: b.path, description: b.description },
      });
    }
  }
  return pairs
    .sort((a, b) => b.score - a.score || a.left.path.localeCompare(b.left.path))
    .slice(0, top);
}

export function auditCompiledTaxonomy(taxonomy, options = {}) {
  const top = options.top ?? 30;
  const childParents = new Set(
    taxonomy.categories
      .map((category) => category.parentKey)
      .filter(Boolean),
  );
  const structural = taxonomy.categories.filter((category) => childParents.has(category.key));
  const semanticNonLeaves = taxonomy.semanticCategories.filter((category) => childParents.has(category.key));
  const language = options.language && options.language !== "auto"
    ? options.language
    : detectLanguage(taxonomy);

  const languageProblems = language === "ru"
    ? taxonomy.categories
      .map((category) => ({ category, stats: cyrillicStats(category.description) }))
      .filter(({ stats }) => stats.cyrillic < 4 || stats.ratio < 0.25)
      .map(({ category, stats }) => ({
        key: category.key,
        path: category.path,
        description: category.description,
        cyrillicLetters: stats.cyrillic,
        letterRatio: stats.ratio,
      }))
    : [];

  const shortDescriptions = taxonomy.categories
    .filter((category) => normalizeDescription(category.description).length < 32)
    .map(({ key, path, description }) => ({ key, path, description }));

  return {
    schemaVersion: 1,
    taxonomyHash: taxonomy.taxonomyHash,
    language,
    counts: {
      total: taxonomy.categories.length,
      routeable: taxonomy.routeableCategories.length,
      semantic: taxonomy.semanticCategories.length,
      structural: structural.length,
    },
    fallback: {
      key: taxonomy.fallbackKey,
      uri: taxonomy.fallbackUri,
      path: taxonomy.byKey.get(taxonomy.fallbackKey)?.path,
      appearsInSemanticRanking: taxonomy.semanticCategories.some((category) => category.key === taxonomy.fallbackKey),
    },
    structuralRouteable: structural
      .filter((category) => category.routeable && category.key !== taxonomy.fallbackKey)
      .map(({ key, path, description }) => ({ key, path, description })),
    semanticNonLeaves: semanticNonLeaves
      .map(({ key, path, description }) => ({ key, path, description })),
    exactDuplicateDescriptions: exactDuplicateGroups(taxonomy.categories),
    repeatedSegments: repeatedSegments(taxonomy.categories),
    shortDescriptions,
    languageProblems,
    lexicalNearPairs: lexicalNearPairs(taxonomy.semanticCategories, top),
    embeddingNearPairs: embeddingNearPairs(taxonomy, options.cache, top),
  };
}

function loadFromConfig(options) {
  const document = readJson(options.configFile, "OpenClaw config");
  const config = parseResourceRoutingConfig(extractRoutingConfig(document));
  const taxonomyFile = options.taxonomyFile
    ?? resolvePerAgentFileTemplate(config.taxonomyFile, options.agentId);
  const taxonomy = loadResourceTaxonomyFile(taxonomyFile);
  const cacheFile = options.cacheFile
    ?? resolvePerAgentFileTemplate(config.cacheFile, options.agentId);

  let cache;
  let cacheStatus = { state: "missing", file: cacheFile };
  if (existsSync(cacheFile)) {
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
    if (loaded.hit) {
      cache = loaded.cache;
      cacheStatus = { state: "valid", file: cacheFile };
    } else {
      cacheStatus = { state: "invalid", file: cacheFile, reason: loaded.reason };
    }
  }
  return { config, taxonomy, taxonomyFile, cache, cacheStatus };
}

function loadStandalone(options) {
  if (!options.taxonomyFile) {
    throw new Error("Standalone audit requires --taxonomy <file>");
  }
  const taxonomy = loadResourceTaxonomyFile(options.taxonomyFile);
  let cache;
  let cacheStatus = { state: "not_requested" };
  if (options.cacheFile) {
    const raw = readJson(options.cacheFile, "Routing cache");
    if (raw.taxonomyHash !== taxonomy.taxonomyHash) {
      cacheStatus = { state: "invalid", file: options.cacheFile, reason: "taxonomy_hash" };
    } else {
      const expectedKeys = taxonomy.semanticCategories.map((category) => category.key);
      const actualKeys = Array.isArray(raw.categories) ? raw.categories.map((entry) => entry?.key) : [];
      if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
        cacheStatus = { state: "invalid", file: options.cacheFile, reason: "category_keys" };
      } else {
        cache = raw;
        cacheStatus = { state: "valid_unverified_identity", file: options.cacheFile };
      }
    }
  }
  return {
    taxonomy,
    taxonomyFile: options.taxonomyFile,
    cache,
    cacheStatus,
  };
}

function formatScore(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(4) : "n/a";
}

function printPairs(label, pairs) {
  console.log(`${label}: ${pairs.length}`);
  for (const pair of pairs) {
    console.log(
      `  ${formatScore(pair.score)} ${pair.left.key}[${pair.left.path}] <-> ` +
      `${pair.right.key}[${pair.right.path}]${pair.sameParent ? " sibling" : ""}`,
    );
    console.log(`    L: ${pair.left.description}`);
    console.log(`    R: ${pair.right.description}`);
  }
}

function usage() {
  return `Usage:
  npm run routing:audit -- --taxonomy /path/taxonomy.yaml --language ru
  npm run routing:audit -- --agent main --language ru
  npm run routing:audit -- --agent main --language ru --json

The audit is READ-ONLY and makes no model calls. With normal OpenClaw config it also
loads a valid existing routing cache, when available, and reports the nearest category
embedding pairs. Without a cache it still performs the complete structural/text audit.

Options:
  --config PATH       OpenClaw config (default ~/.openclaw/openclaw.json)
  --agent ID          Agent used for {agentId} templates (default main)
  --taxonomy PATH     Explicit taxonomy file; with missing config, standalone mode
  --cache PATH        Explicit cache file
  --language auto|ru|any  Description language validation (default auto)
  --top N             Number of lexical/embedding confusion pairs (default 30)
  --json              Full JSON report
`;
}

async function main() {
  const options = parseAuditArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  let loaded;
  try {
    loaded = loadFromConfig(options);
  } catch (error) {
    if (!options.taxonomyFile) throw error;
    loaded = loadStandalone(options);
  }
  const report = auditCompiledTaxonomy(loaded.taxonomy, {
    top: options.top,
    language: options.language ?? "auto",
    cache: loaded.cache,
  });
  const result = {
    readOnly: true,
    taxonomyFile: loaded.taxonomyFile,
    cache: loaded.cacheStatus,
    ...report,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  console.log("resource taxonomy audit: READ-ONLY; model calls=0");
  console.log(`taxonomy: ${result.taxonomyFile}`);
  console.log(
    `counts: total=${result.counts.total} routeable=${result.counts.routeable} ` +
    `semantic=${result.counts.semantic} structural=${result.counts.structural}`,
  );
  console.log(
    `fallback: ${result.fallback.key}[${result.fallback.path ?? "n/a"}] ` +
    `semanticCandidate=${result.fallback.appearsInSemanticRanking}`,
  );
  console.log(`cache: ${result.cache.state}${result.cache.file ? ` ${result.cache.file}` : ""}${result.cache.reason ? ` (${result.cache.reason})` : ""}`);
  console.log(`language: ${result.language}; languageProblems=${result.languageProblems.length}`);
  console.log(`structuralRouteable=${result.structuralRouteable.length} semanticNonLeaves=${result.semanticNonLeaves.length}`);
  console.log(`exactDuplicateDescriptions=${result.exactDuplicateDescriptions.length} shortDescriptions=${result.shortDescriptions.length}`);
  console.log(`repeatedSegments=${result.repeatedSegments.length} (informational; full paths remain unique)`);
  console.log("");
  printPairs("lexical near pairs", result.lexicalNearPairs);
  if (result.embeddingNearPairs.length > 0) {
    console.log("");
    printPairs("embedding near pairs", result.embeddingNearPairs);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(`routing taxonomy audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
