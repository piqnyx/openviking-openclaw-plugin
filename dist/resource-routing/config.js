import { homedir } from "node:os";
import { getEnv } from "../runtime-utils.js";
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SEMANTIC_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const AGENT_ID_TOKEN = "{agentId}";
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
export const DEFAULT_RESOURCE_ROUTING_TAXONOMY_FILE_TEMPLATE = "~/.openclaw/{agentId}.yaml";
export const DEFAULT_RESOURCE_ROUTING_CACHE_FILE_TEMPLATE = "~/.openclaw/cache/openviking-resource-routing/{agentId}.json";
export const DEFAULT_RESOURCE_ROUTING_SEMANTIC_INPUT_TEMPLATE = "{{summary}}";
export const DEFAULT_RESOURCE_ROUTING_FALLBACK_CATEGORY = "inbox";
export const DEFAULT_RESOURCE_ROUTING_EMBEDDING_BASE_URL = "http://127.0.0.1:18081";
export const DEFAULT_RESOURCE_ROUTING_EMBEDDING_ENDPOINT = "/v1/embeddings";
export const DEFAULT_RESOURCE_ROUTING_EMBEDDING_MODEL = "bge-m3";
export const DEFAULT_RESOURCE_ROUTING_EMBEDDING_DIMENSIONS = 1024;
export const DEFAULT_RESOURCE_ROUTING_RERANKER_BASE_URL = "http://127.0.0.1:18080";
export const DEFAULT_RESOURCE_ROUTING_RERANKER_ENDPOINT = "/v1/rerank";
export const DEFAULT_RESOURCE_ROUTING_RERANKER_MODEL = "bge-reranker-v2-m3";
export const DEFAULT_RESOURCE_ROUTING_PROVIDER_TIMEOUT_MS = 3_000;
export const DEFAULT_RESOURCE_ROUTING_TOP_K = 2;
export const DEFAULT_RESOURCE_ROUTING_MIN_SCORE = 0.64;
export const DEFAULT_RESOURCE_ROUTING_RERANK_BELOW_MARGIN = 0.06;
function toRecord(value, label) {
    if (value === undefined || value === null) {
        return {};
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}
function assertAllowedKeys(value, allowed, label) {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
        throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
    }
}
function resolveEnvVars(value) {
    return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
        const envValue = getEnv(envVar);
        if (!envValue) {
            throw new Error(`Environment variable ${envVar} is not set`);
        }
        return envValue;
    });
}
function expandHomeDir(value) {
    if (value === "~") {
        return homedir();
    }
    if (value.startsWith("~/")) {
        return `${homedir()}${value.slice(1)}`;
    }
    return value;
}
function stringValue(value, fallback, label, options = {}) {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== "string") {
        throw new Error(`${label} must be a string`);
    }
    const trimmed = value.trim();
    if (!trimmed && !options.allowEmpty) {
        throw new Error(`${label} must not be empty`);
    }
    return options.expandEnv === false ? trimmed : resolveEnvVars(trimmed);
}
function numberValue(value, fallback, label, min, max, integer = false) {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number`);
    }
    const normalized = integer ? Math.floor(value) : value;
    if (normalized < min || normalized > max) {
        throw new Error(`${label} must be between ${min} and ${max}`);
    }
    return normalized;
}
function stringRecord(value, label) {
    const record = toRecord(value, label);
    const result = {};
    for (const [key, raw] of Object.entries(record)) {
        if (!key.trim()) {
            throw new Error(`${label} contains an empty header name`);
        }
        if (typeof raw !== "string") {
            throw new Error(`${label}.${key} must be a string`);
        }
        result[key] = resolveEnvVars(raw);
    }
    return result;
}
function agentScopedTemplate(value, fallback, label) {
    const template = expandHomeDir(stringValue(value, fallback, label));
    if (!template.includes(AGENT_ID_TOKEN)) {
        throw new Error(`${label} must contain ${AGENT_ID_TOKEN} so agent files remain isolated`);
    }
    return template;
}
function semanticInputTemplate(value) {
    const template = stringValue(value, DEFAULT_RESOURCE_ROUTING_SEMANTIC_INPUT_TEMPLATE, "openviking config resourceRouting.semanticInputTemplate", { expandEnv: false });
    const placeholders = [...template.matchAll(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g)].map((match) => match[1]);
    const malformed = template.replace(/\{\{[A-Za-z][A-Za-z0-9]*\}\}/g, "");
    if (malformed.includes("{{") || malformed.includes("}}")) {
        throw new Error("openviking config resourceRouting.semanticInputTemplate contains a malformed placeholder");
    }
    const unknown = [
        ...new Set(placeholders.filter((field) => !ALLOWED_SEMANTIC_INPUT_FIELDS.has(field))),
    ];
    if (unknown.length > 0) {
        throw new Error(`openviking config resourceRouting.semanticInputTemplate contains unknown fields: ${unknown.join(", ")}`);
    }
    if (!placeholders.includes("summary")) {
        throw new Error("openviking config resourceRouting.semanticInputTemplate must contain {{summary}}");
    }
    return template;
}
function endpointValue(value, fallback, label) {
    const endpoint = stringValue(value, fallback, label, { expandEnv: false });
    if (!endpoint.startsWith("/") || endpoint.startsWith("//") || endpoint.includes("://")) {
        throw new Error(`${label} must be an absolute HTTP path beginning with one "/"`);
    }
    return endpoint;
}
function baseUrlValue(value, fallback, label) {
    return stringValue(value, fallback, label).replace(/\/+$/, "");
}
function parseProvider(value, label, defaults, extraAllowedKeys = []) {
    const raw = toRecord(value, label);
    assertAllowedKeys(raw, ["baseUrl", "endpoint", "apiKey", "headers", "model", "timeoutMs", ...extraAllowedKeys], label);
    return {
        baseUrl: baseUrlValue(raw.baseUrl, defaults.baseUrl, `${label}.baseUrl`),
        endpoint: endpointValue(raw.endpoint, defaults.endpoint, `${label}.endpoint`),
        apiKey: stringValue(raw.apiKey, "", `${label}.apiKey`, { allowEmpty: true }),
        headers: stringRecord(raw.headers, `${label}.headers`),
        model: stringValue(raw.model, defaults.model, `${label}.model`),
        timeoutMs: numberValue(raw.timeoutMs, DEFAULT_RESOURCE_ROUTING_PROVIDER_TIMEOUT_MS, `${label}.timeoutMs`, 100, 300_000, true),
    };
}
export function resolveAgentScopedResourceRoutingPath(template, agentId) {
    const normalizedAgentId = agentId.trim();
    if (!AGENT_ID_PATTERN.test(normalizedAgentId)) {
        throw new Error(`resource routing agent id ${JSON.stringify(agentId)} must match [A-Za-z0-9_-]+`);
    }
    if (!template.includes(AGENT_ID_TOKEN)) {
        throw new Error(`resource routing path template must contain ${AGENT_ID_TOKEN}`);
    }
    return template.split(AGENT_ID_TOKEN).join(normalizedAgentId);
}
export function parseResourceRoutingConfig(value) {
    const raw = toRecord(value, "openviking config resourceRouting");
    assertAllowedKeys(raw, [
        "enabled",
        "taxonomyFileTemplate",
        "cacheFileTemplate",
        "semanticInputTemplate",
        "fallbackCategory",
        "embedding",
        "reranker",
        "retrieval",
    ], "openviking config resourceRouting");
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
        throw new Error("openviking config resourceRouting.enabled must be a boolean");
    }
    const embeddingRaw = toRecord(raw.embedding, "openviking config resourceRouting.embedding");
    assertAllowedKeys(embeddingRaw, ["baseUrl", "endpoint", "apiKey", "headers", "model", "timeoutMs", "dimensions"], "openviking config resourceRouting.embedding");
    const embedding = parseProvider(embeddingRaw, "openviking config resourceRouting.embedding", {
        baseUrl: DEFAULT_RESOURCE_ROUTING_EMBEDDING_BASE_URL,
        endpoint: DEFAULT_RESOURCE_ROUTING_EMBEDDING_ENDPOINT,
        model: DEFAULT_RESOURCE_ROUTING_EMBEDDING_MODEL,
    }, ["dimensions"]);
    const reranker = parseProvider(raw.reranker, "openviking config resourceRouting.reranker", {
        baseUrl: DEFAULT_RESOURCE_ROUTING_RERANKER_BASE_URL,
        endpoint: DEFAULT_RESOURCE_ROUTING_RERANKER_ENDPOINT,
        model: DEFAULT_RESOURCE_ROUTING_RERANKER_MODEL,
    });
    const retrievalRaw = toRecord(raw.retrieval, "openviking config resourceRouting.retrieval");
    assertAllowedKeys(retrievalRaw, ["topK", "minScore", "rerankBelowMargin"], "openviking config resourceRouting.retrieval");
    const fallbackCategory = stringValue(raw.fallbackCategory, DEFAULT_RESOURCE_ROUTING_FALLBACK_CATEGORY, "openviking config resourceRouting.fallbackCategory", { expandEnv: false });
    if (!SEMANTIC_KEY_PATTERN.test(fallbackCategory)) {
        throw new Error("openviking config resourceRouting.fallbackCategory must match [a-z0-9][a-z0-9._-]*");
    }
    return {
        enabled: raw.enabled === true,
        taxonomyFileTemplate: agentScopedTemplate(raw.taxonomyFileTemplate, DEFAULT_RESOURCE_ROUTING_TAXONOMY_FILE_TEMPLATE, "openviking config resourceRouting.taxonomyFileTemplate"),
        cacheFileTemplate: agentScopedTemplate(raw.cacheFileTemplate, DEFAULT_RESOURCE_ROUTING_CACHE_FILE_TEMPLATE, "openviking config resourceRouting.cacheFileTemplate"),
        semanticInputTemplate: semanticInputTemplate(raw.semanticInputTemplate),
        fallbackCategory,
        embedding: {
            ...embedding,
            dimensions: numberValue(embeddingRaw.dimensions, DEFAULT_RESOURCE_ROUTING_EMBEDDING_DIMENSIONS, "openviking config resourceRouting.embedding.dimensions", 1, 65_536, true),
        },
        reranker,
        retrieval: {
            topK: numberValue(retrievalRaw.topK, DEFAULT_RESOURCE_ROUTING_TOP_K, "openviking config resourceRouting.retrieval.topK", 1, 50, true),
            minScore: numberValue(retrievalRaw.minScore, DEFAULT_RESOURCE_ROUTING_MIN_SCORE, "openviking config resourceRouting.retrieval.minScore", 0, 1),
            rerankBelowMargin: numberValue(retrievalRaw.rerankBelowMargin, DEFAULT_RESOURCE_ROUTING_RERANK_BELOW_MARGIN, "openviking config resourceRouting.retrieval.rerankBelowMargin", 0, 1),
        },
    };
}
