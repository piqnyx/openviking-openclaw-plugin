import { getEnv } from "../runtime-utils.js";
import { resolveAgentScopedResourceRoutingPath } from "./agent-paths.js";

const DEFAULT_TAXONOMY_FILE = "~/.openclaw/{agentId}.yaml";
const DEFAULT_CACHE_FILE = "~/.openclaw/cache/openviking-resource-routing/{agentId}.json";
const DEFAULT_AUDIT_FILE = "~/.openclaw/logs/openviking-resource-routing/{agentId}.jsonl";
const DEFAULT_EMBEDDING_BASE_URL = "http://127.0.0.1:18081";
const DEFAULT_EMBEDDING_ENDPOINT_PATH = "/v1/embeddings";
const DEFAULT_EMBEDDING_MODEL = "bge-m3";
const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;
const DEFAULT_EMBEDDING_DIMENSIONS = 1_024;
const DEFAULT_RERANKER_BASE_URL = "http://127.0.0.1:18080";
const DEFAULT_RERANKER_ENDPOINT_PATH = "/v1/rerank";
const DEFAULT_RERANKER_MODEL = "bge-reranker-v2-m3";
const DEFAULT_RERANKER_TIMEOUT_MS = 3_000;
const DEFAULT_TOP_K = 2;
const DEFAULT_MIN_SCORE = 0.64;
const DEFAULT_RERANK_BELOW_MARGIN = 0.06;
const DEFAULT_FALLBACK_CATEGORY = "inbox";
const DEFAULT_SEMANTIC_INPUT_TEMPLATE = "{{summary}}";
const DEFAULT_FAILURE_POLICY = "error" as const;

const ALLOWED_TEMPLATE_FIELDS = new Set([
  "summary",
  "filename",
  "extension",
  "mimeType",
  "sourceKind",
  "source",
  "reason",
  "instruction",
  "agentId",
]);

export type ResourceRoutingEndpointInput = {
  baseUrl?: unknown;
  endpointPath?: unknown;
  apiKey?: unknown;
  headers?: unknown;
  model?: unknown;
  timeoutMs?: unknown;
};

export type ResourceRoutingConfigInput = {
  enabled?: unknown;
  taxonomyFile?: unknown;
  cacheFile?: unknown;
  auditFile?: unknown;
  semanticInputTemplate?: unknown;
  fallbackCategory?: unknown;
  failurePolicy?: unknown;
  embedding?: ResourceRoutingEndpointInput & { dimensions?: unknown };
  reranker?: ResourceRoutingEndpointInput;
  retrieval?: {
    topK?: unknown;
    minScore?: unknown;
    rerankBelowMargin?: unknown;
  };
  audit?: {
    enabled?: unknown;
    includeSummaryPreview?: unknown;
    summaryPreviewChars?: unknown;
  };
};

export type ParsedResourceRoutingEndpoint = {
  baseUrl: string;
  endpointPath: string;
  apiKey: string;
  headers: Record<string, string>;
  model: string;
  timeoutMs: number;
};

export type ParsedResourceRoutingConfig = {
  enabled: boolean;
  taxonomyFile: string;
  cacheFile: string;
  auditFile: string;
  semanticInputTemplate: string;
  fallbackCategory: string;
  failurePolicy: "error";
  embedding: ParsedResourceRoutingEndpoint & { dimensions: number };
  reranker: ParsedResourceRoutingEndpoint;
  retrieval: {
    topK: number;
    minScore: number;
    rerankBelowMargin: number;
  };
  audit: {
    enabled: boolean;
    includeSummaryPreview: boolean;
    summaryPreviewChars: number;
  };
};

export type ResolvedAgentResourceRoutingPaths = {
  taxonomyFile: string;
  cacheFile: string;
  auditFile: string;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, envName: string) => {
    const resolved = getEnv(envName);
    if (resolved === undefined || resolved === "") {
      throw new Error(`Environment variable ${envName} is not set`);
    }
    return resolved;
  });
}

function stringValue(value: unknown, fallback: string, label: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return expandEnv(value.trim());
}

function booleanValue(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function numberInRange(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function integerInRange(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const parsed = numberInRange(value, fallback, min, max, label);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer`);
  }
  return parsed;
}

function parseHeaders(value: unknown, label: string): Record<string, string> {
  const record = asRecord(value, label);
  const headers: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(record)) {
    if (!key.trim()) {
      throw new Error(`${label} contains an empty header name`);
    }
    if (typeof rawValue !== "string") {
      throw new Error(`${label}.${key} must be a string`);
    }
    headers[key] = expandEnv(rawValue);
  }
  return headers;
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`resourceRouting endpoint baseUrl is invalid: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`resourceRouting endpoint baseUrl must use http or https: ${value}`);
  }
  return value.replace(/\/+$/, "");
}

function normalizeEndpointPath(value: string, label: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("?") || value.includes("#")) {
    throw new Error(`${label} must be an absolute URL path without query or fragment`);
  }
  return value;
}

function parseEndpoint(
  value: unknown,
  defaults: {
    baseUrl: string;
    endpointPath: string;
    model: string;
    timeoutMs: number;
  },
  label: string,
  extraAllowedKeys: readonly string[] = [],
): ParsedResourceRoutingEndpoint {
  const record = asRecord(value, label);
  assertAllowedKeys(
    record,
    ["baseUrl", "endpointPath", "apiKey", "headers", "model", "timeoutMs", ...extraAllowedKeys],
    label,
  );
  return {
    baseUrl: normalizeBaseUrl(stringValue(record.baseUrl, defaults.baseUrl, `${label}.baseUrl`)),
    endpointPath: normalizeEndpointPath(
      stringValue(record.endpointPath, defaults.endpointPath, `${label}.endpointPath`),
      `${label}.endpointPath`,
    ),
    apiKey:
      record.apiKey === undefined || record.apiKey === null || record.apiKey === ""
        ? ""
        : stringValue(record.apiKey, "", `${label}.apiKey`),
    headers: parseHeaders(record.headers, `${label}.headers`),
    model: stringValue(record.model, defaults.model, `${label}.model`),
    timeoutMs: integerInRange(record.timeoutMs, defaults.timeoutMs, 100, 300_000, `${label}.timeoutMs`),
  };
}

function validatePathTemplate(value: string, label: string): string {
  if (!value.includes("{agentId}")) {
    throw new Error(`${label} must contain {agentId} so every isolated agent gets its own file`);
  }
  return value;
}

function validateSemanticInputTemplate(value: string): string {
  const placeholders = [...value.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g)].map((match) => match[1]);
  if (!placeholders.includes("summary")) {
    throw new Error("openviking config resourceRouting.semanticInputTemplate must include {{summary}}");
  }
  const unknown = placeholders.filter((field) => !ALLOWED_TEMPLATE_FIELDS.has(field));
  if (unknown.length > 0) {
    throw new Error(`openviking config resourceRouting.semanticInputTemplate contains unknown fields: ${[...new Set(unknown)].join(", ")}`);
  }
  return value;
}

export function parseResourceRoutingConfig(value: unknown): ParsedResourceRoutingConfig {
  const cfg = asRecord(value, "openviking config resourceRouting");
  assertAllowedKeys(
    cfg,
    [
      "enabled",
      "taxonomyFile",
      "cacheFile",
      "auditFile",
      "semanticInputTemplate",
      "fallbackCategory",
      "failurePolicy",
      "embedding",
      "reranker",
      "retrieval",
      "audit",
    ],
    "openviking config resourceRouting",
  );

  const embeddingRaw = asRecord(cfg.embedding, "openviking config resourceRouting.embedding");
  const embeddingBase = parseEndpoint(
    embeddingRaw,
    {
      baseUrl: DEFAULT_EMBEDDING_BASE_URL,
      endpointPath: DEFAULT_EMBEDDING_ENDPOINT_PATH,
      model: DEFAULT_EMBEDDING_MODEL,
      timeoutMs: DEFAULT_EMBEDDING_TIMEOUT_MS,
    },
    "openviking config resourceRouting.embedding",
    ["dimensions"],
  );
  const reranker = parseEndpoint(
    cfg.reranker,
    {
      baseUrl: DEFAULT_RERANKER_BASE_URL,
      endpointPath: DEFAULT_RERANKER_ENDPOINT_PATH,
      model: DEFAULT_RERANKER_MODEL,
      timeoutMs: DEFAULT_RERANKER_TIMEOUT_MS,
    },
    "openviking config resourceRouting.reranker",
  );

  const retrieval = asRecord(cfg.retrieval, "openviking config resourceRouting.retrieval");
  assertAllowedKeys(retrieval, ["topK", "minScore", "rerankBelowMargin"], "openviking config resourceRouting.retrieval");
  const audit = asRecord(cfg.audit, "openviking config resourceRouting.audit");
  assertAllowedKeys(audit, ["enabled", "includeSummaryPreview", "summaryPreviewChars"], "openviking config resourceRouting.audit");

  const failurePolicy = stringValue(
    cfg.failurePolicy,
    DEFAULT_FAILURE_POLICY,
    "openviking config resourceRouting.failurePolicy",
  );
  if (failurePolicy !== "error") {
    throw new Error('openviking config resourceRouting.failurePolicy currently supports only "error"');
  }

  return {
    enabled: booleanValue(cfg.enabled, false, "openviking config resourceRouting.enabled"),
    taxonomyFile: validatePathTemplate(
      stringValue(cfg.taxonomyFile, DEFAULT_TAXONOMY_FILE, "openviking config resourceRouting.taxonomyFile"),
      "openviking config resourceRouting.taxonomyFile",
    ),
    cacheFile: validatePathTemplate(
      stringValue(cfg.cacheFile, DEFAULT_CACHE_FILE, "openviking config resourceRouting.cacheFile"),
      "openviking config resourceRouting.cacheFile",
    ),
    auditFile: validatePathTemplate(
      stringValue(cfg.auditFile, DEFAULT_AUDIT_FILE, "openviking config resourceRouting.auditFile"),
      "openviking config resourceRouting.auditFile",
    ),
    semanticInputTemplate: validateSemanticInputTemplate(
      stringValue(
        cfg.semanticInputTemplate,
        DEFAULT_SEMANTIC_INPUT_TEMPLATE,
        "openviking config resourceRouting.semanticInputTemplate",
      ),
    ),
    fallbackCategory: stringValue(
      cfg.fallbackCategory,
      DEFAULT_FALLBACK_CATEGORY,
      "openviking config resourceRouting.fallbackCategory",
    ),
    failurePolicy: "error",
    embedding: {
      ...embeddingBase,
      dimensions: integerInRange(
        embeddingRaw.dimensions,
        DEFAULT_EMBEDDING_DIMENSIONS,
        1,
        65_536,
        "openviking config resourceRouting.embedding.dimensions",
      ),
    },
    reranker,
    retrieval: {
      topK: integerInRange(retrieval.topK, DEFAULT_TOP_K, 1, 50, "openviking config resourceRouting.retrieval.topK"),
      minScore: numberInRange(retrieval.minScore, DEFAULT_MIN_SCORE, -1, 1, "openviking config resourceRouting.retrieval.minScore"),
      rerankBelowMargin: numberInRange(
        retrieval.rerankBelowMargin,
        DEFAULT_RERANK_BELOW_MARGIN,
        0,
        2,
        "openviking config resourceRouting.retrieval.rerankBelowMargin",
      ),
    },
    audit: {
      enabled: booleanValue(audit.enabled, true, "openviking config resourceRouting.audit.enabled"),
      includeSummaryPreview: booleanValue(
        audit.includeSummaryPreview,
        false,
        "openviking config resourceRouting.audit.includeSummaryPreview",
      ),
      summaryPreviewChars: integerInRange(
        audit.summaryPreviewChars,
        240,
        20,
        4_000,
        "openviking config resourceRouting.audit.summaryPreviewChars",
      ),
    },
  };
}

export function resolveAgentResourceRoutingPaths(
  config: ParsedResourceRoutingConfig,
  agentId: string,
): ResolvedAgentResourceRoutingPaths {
  return {
    taxonomyFile: resolveAgentScopedResourceRoutingPath(config.taxonomyFile, agentId),
    cacheFile: resolveAgentScopedResourceRoutingPath(config.cacheFile, agentId),
    auditFile: resolveAgentScopedResourceRoutingPath(config.auditFile, agentId),
  };
}

export const RESOURCE_ROUTING_CONFIG_DEFAULTS = {
  taxonomyFile: DEFAULT_TAXONOMY_FILE,
  cacheFile: DEFAULT_CACHE_FILE,
  auditFile: DEFAULT_AUDIT_FILE,
  embeddingBaseUrl: DEFAULT_EMBEDDING_BASE_URL,
  embeddingEndpointPath: DEFAULT_EMBEDDING_ENDPOINT_PATH,
  embeddingModel: DEFAULT_EMBEDDING_MODEL,
  embeddingTimeoutMs: DEFAULT_EMBEDDING_TIMEOUT_MS,
  embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS,
  rerankerBaseUrl: DEFAULT_RERANKER_BASE_URL,
  rerankerEndpointPath: DEFAULT_RERANKER_ENDPOINT_PATH,
  rerankerModel: DEFAULT_RERANKER_MODEL,
  rerankerTimeoutMs: DEFAULT_RERANKER_TIMEOUT_MS,
  topK: DEFAULT_TOP_K,
  minScore: DEFAULT_MIN_SCORE,
  rerankBelowMargin: DEFAULT_RERANK_BELOW_MARGIN,
  fallbackCategory: DEFAULT_FALLBACK_CATEGORY,
  semanticInputTemplate: DEFAULT_SEMANTIC_INPUT_TEMPLATE,
} as const;
