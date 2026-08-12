import { getEnv } from "../runtime-utils.js";
import { resolvePerAgentFileTemplate } from "./resource-taxonomy.js";
const DEFAULT_TAXONOMY_FILE = "~/.openclaw/{agentId}.yaml";
const DEFAULT_CACHE_FILE = "~/.openclaw/openviking/resource-routing-cache/{agentId}.json";
const DEFAULT_AUDIT_FILE = "~/.openclaw/openviking/resource-routing-audit/{agentId}.jsonl";
const DEFAULT_EMBEDDING_BASE_URL = "http://127.0.0.1:18081";
const DEFAULT_EMBEDDING_MODEL = "bge-m3";
const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_RERANKER_BASE_URL = "http://127.0.0.1:18080";
const DEFAULT_RERANKER_MODEL = "bge-reranker-v2-m3";
const DEFAULT_HTTP_TIMEOUT_MS = 3000;
const DEFAULT_TOP_K = 2;
const DEFAULT_MIN_SCORE = 0.64;
const DEFAULT_RERANK_BELOW_MARGIN = 0.06;
const DEFAULT_FALLBACK_CATEGORY = "inbox";
const DEFAULT_SEMANTIC_INPUT_TEMPLATE = "{{summary}}";
const DEFAULT_SUMMARY_LANGUAGE = "any";
const DEFAULT_AUDIT_SUMMARY_PREVIEW_CHARS = 240;
const SEMANTIC_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const TEMPLATE_PLACEHOLDER_RE = /{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g;
const ALLOWED_SEMANTIC_INPUT_FIELDS = new Set([
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
function assertRecord(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
}
function toRecord(value, label) {
    if (value === undefined || value === null) {
        return {};
    }
    assertRecord(value, label);
    return value;
}
function assertAllowedKeys(value, allowed, label) {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
        throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
    }
}
function expandEnv(value, label) {
    return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
        const envValue = getEnv(envVar);
        if (envValue === undefined || envValue === "") {
            throw new Error(`${label} references environment variable ${envVar}, but it is not set`);
        }
        return envValue;
    });
}
function stringValue(value, fallback, label) {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value.trim();
}
function numberValue(value, fallback, label) {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number`);
    }
    return value;
}
function integerInRange(value, fallback, min, max, label) {
    const parsed = numberValue(value, fallback, label);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${label} must be an integer between ${min} and ${max}`);
    }
    return parsed;
}
function numberInRange(value, fallback, min, max, label) {
    const parsed = numberValue(value, fallback, label);
    if (parsed < min || parsed > max) {
        throw new Error(`${label} must be between ${min} and ${max}`);
    }
    return parsed;
}
function parseFileTemplate(value, fallback, label) {
    const template = expandEnv(stringValue(value, fallback, label), label);
    resolvePerAgentFileTemplate(template, "validation-agent");
    return template;
}
function parseHeaders(value, label) {
    if (value === undefined || value === null) {
        return {};
    }
    assertRecord(value, label);
    const headers = {};
    for (const [name, raw] of Object.entries(value)) {
        if (!name.trim()) {
            throw new Error(`${label} contains an empty header name`);
        }
        if (typeof raw !== "string") {
            throw new Error(`${label}.${name} must be a string`);
        }
        headers[name] = expandEnv(raw, `${label}.${name}`);
    }
    return headers;
}
function parseBaseUrl(value, fallback, label) {
    const raw = expandEnv(stringValue(value, fallback, label), label).replace(/\/+$/, "");
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new Error(`${label} must be a valid http(s) URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`${label} must use http or https`);
    }
    return raw;
}
function parseEndpoint(value, defaults, label, extraAllowedKeys = []) {
    const endpoint = toRecord(value, label);
    assertAllowedKeys(endpoint, ["baseUrl", "model", "apiKey", "headers", "timeoutMs", ...extraAllowedKeys], label);
    const rawApiKey = endpoint.apiKey === undefined
        ? ""
        : stringValue(endpoint.apiKey, "", `${label}.apiKey`);
    return {
        baseUrl: parseBaseUrl(endpoint.baseUrl, defaults.baseUrl, `${label}.baseUrl`),
        model: stringValue(endpoint.model, defaults.model, `${label}.model`),
        apiKey: rawApiKey ? expandEnv(rawApiKey, `${label}.apiKey`) : "",
        headers: parseHeaders(endpoint.headers, `${label}.headers`),
        timeoutMs: integerInRange(endpoint.timeoutMs, DEFAULT_HTTP_TIMEOUT_MS, 100, 300_000, `${label}.timeoutMs`),
    };
}
function parseSemanticInputTemplate(value) {
    const template = stringValue(value, DEFAULT_SEMANTIC_INPUT_TEMPLATE, "openviking resourceRouting.semanticInputTemplate");
    const fields = [...template.matchAll(TEMPLATE_PLACEHOLDER_RE)].map((match) => match[1]);
    const unknown = [...new Set(fields.filter((field) => !ALLOWED_SEMANTIC_INPUT_FIELDS.has(field)))];
    if (unknown.length > 0) {
        throw new Error(`openviking resourceRouting.semanticInputTemplate has unknown placeholders: ${unknown.join(", ")}`);
    }
    if (!fields.includes("summary")) {
        throw new Error("openviking resourceRouting.semanticInputTemplate must include {{summary}}");
    }
    return template;
}
function parseSummaryLanguage(value) {
    if (value === undefined || value === null) {
        return DEFAULT_SUMMARY_LANGUAGE;
    }
    if (value === "any" || value === "ru") {
        return value;
    }
    throw new Error('openviking resourceRouting.summaryLanguage must be "any" or "ru"');
}
export function parseResourceRoutingConfig(value) {
    const cfg = toRecord(value, "openviking resourceRouting");
    assertAllowedKeys(cfg, [
        "enabled",
        "taxonomyFile",
        "cacheFile",
        "semanticInputTemplate",
        "summaryLanguage",
        "embedding",
        "reranker",
        "retrieval",
        "fallbackCategory",
        "failurePolicy",
        "audit",
    ], "openviking resourceRouting");
    if (cfg.enabled !== undefined && typeof cfg.enabled !== "boolean") {
        throw new Error("openviking resourceRouting.enabled must be a boolean");
    }
    const embeddingRaw = toRecord(cfg.embedding, "openviking resourceRouting.embedding");
    const embedding = parseEndpoint(embeddingRaw, { baseUrl: DEFAULT_EMBEDDING_BASE_URL, model: DEFAULT_EMBEDDING_MODEL }, "openviking resourceRouting.embedding", ["dimensions"]);
    const reranker = parseEndpoint(cfg.reranker, { baseUrl: DEFAULT_RERANKER_BASE_URL, model: DEFAULT_RERANKER_MODEL }, "openviking resourceRouting.reranker");
    const retrieval = toRecord(cfg.retrieval, "openviking resourceRouting.retrieval");
    assertAllowedKeys(retrieval, ["topK", "minScore", "rerankBelowMargin"], "openviking resourceRouting.retrieval");
    const audit = toRecord(cfg.audit, "openviking resourceRouting.audit");
    assertAllowedKeys(audit, ["enabled", "file", "summaryPreviewChars"], "openviking resourceRouting.audit");
    if (audit.enabled !== undefined && typeof audit.enabled !== "boolean") {
        throw new Error("openviking resourceRouting.audit.enabled must be a boolean");
    }
    const fallbackCategory = stringValue(cfg.fallbackCategory, DEFAULT_FALLBACK_CATEGORY, "openviking resourceRouting.fallbackCategory");
    if (!SEMANTIC_KEY_RE.test(fallbackCategory)) {
        throw new Error("openviking resourceRouting.fallbackCategory must be a valid semantic category key");
    }
    if (cfg.failurePolicy !== undefined && cfg.failurePolicy !== "error") {
        throw new Error('openviking resourceRouting.failurePolicy currently supports only "error"');
    }
    return {
        enabled: cfg.enabled === true,
        taxonomyFile: parseFileTemplate(cfg.taxonomyFile, DEFAULT_TAXONOMY_FILE, "openviking resourceRouting.taxonomyFile"),
        cacheFile: parseFileTemplate(cfg.cacheFile, DEFAULT_CACHE_FILE, "openviking resourceRouting.cacheFile"),
        semanticInputTemplate: parseSemanticInputTemplate(cfg.semanticInputTemplate),
        summaryLanguage: parseSummaryLanguage(cfg.summaryLanguage),
        embedding: {
            ...embedding,
            dimensions: integerInRange(embeddingRaw.dimensions, DEFAULT_EMBEDDING_DIMENSIONS, 1, 65_536, "openviking resourceRouting.embedding.dimensions"),
        },
        reranker,
        retrieval: {
            topK: integerInRange(retrieval.topK, DEFAULT_TOP_K, 1, 50, "openviking resourceRouting.retrieval.topK"),
            minScore: numberInRange(retrieval.minScore, DEFAULT_MIN_SCORE, -1, 1, "openviking resourceRouting.retrieval.minScore"),
            rerankBelowMargin: numberInRange(retrieval.rerankBelowMargin, DEFAULT_RERANK_BELOW_MARGIN, 0, 2, "openviking resourceRouting.retrieval.rerankBelowMargin"),
        },
        fallbackCategory,
        failurePolicy: "error",
        audit: {
            enabled: audit.enabled !== false,
            file: parseFileTemplate(audit.file, DEFAULT_AUDIT_FILE, "openviking resourceRouting.audit.file"),
            summaryPreviewChars: integerInRange(audit.summaryPreviewChars, DEFAULT_AUDIT_SUMMARY_PREVIEW_CHARS, 0, 10_000, "openviking resourceRouting.audit.summaryPreviewChars"),
        },
    };
}
export const RESOURCE_ROUTING_DEFAULTS = {
    taxonomyFile: DEFAULT_TAXONOMY_FILE,
    cacheFile: DEFAULT_CACHE_FILE,
    embeddingBaseUrl: DEFAULT_EMBEDDING_BASE_URL,
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    rerankerBaseUrl: DEFAULT_RERANKER_BASE_URL,
    rerankerModel: DEFAULT_RERANKER_MODEL,
    timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    topK: DEFAULT_TOP_K,
    minScore: DEFAULT_MIN_SCORE,
    rerankBelowMargin: DEFAULT_RERANK_BELOW_MARGIN,
    fallbackCategory: DEFAULT_FALLBACK_CATEGORY,
    semanticInputTemplate: DEFAULT_SEMANTIC_INPUT_TEMPLATE,
    summaryLanguage: DEFAULT_SUMMARY_LANGUAGE,
    auditFile: DEFAULT_AUDIT_FILE,
    auditSummaryPreviewChars: DEFAULT_AUDIT_SUMMARY_PREVIEW_CHARS,
};
