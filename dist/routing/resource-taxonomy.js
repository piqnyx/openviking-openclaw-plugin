import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { parseDocument } from "yaml";
export const RESOURCE_TAXONOMY_SCHEMA_VERSION = 1;
export const RESOURCE_TAXONOMY_ROOT_URI = "viking://resources";
const CATEGORY_KEYS = ["segment", "description", "distinguishFrom", "routeable", "children"];
const TAXONOMY_KEYS = ["schemaVersion", "fallback", "categories"];
const SEMANTIC_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MAX_DESCRIPTION_CHARS = 4_000;
function assertRecord(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
}
function assertAllowedKeys(value, allowed, label) {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
        throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
    }
}
function parseNonEmptyString(value, label, maxChars = Number.POSITIVE_INFINITY) {
    if (typeof value !== "string") {
        throw new Error(`${label} must be a string`);
    }
    const normalized = value.trim();
    if (!normalized) {
        throw new Error(`${label} must not be empty`);
    }
    if (normalized.length > maxChars) {
        throw new Error(`${label} must be at most ${maxChars} characters`);
    }
    return normalized;
}
function parseOptionalStringList(value, label) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array of strings`);
    }
    if (value.length > 32) {
        throw new Error(`${label} must contain at most 32 entries`);
    }
    return value.map((entry, index) => parseNonEmptyString(entry, `${label}[${index}]`, 1_000));
}
function parseSemanticKey(value, label) {
    if (!SEMANTIC_KEY_RE.test(value)) {
        throw new Error(`${label} must match ${SEMANTIC_KEY_RE.source}; use a stable semantic key without spaces or path separators`);
    }
    return value;
}
function parseSegment(value, label) {
    const segment = parseNonEmptyString(value, label, 128);
    if (segment === "." || segment === ".." || !SEGMENT_RE.test(segment)) {
        throw new Error(`${label} must be one safe URI segment matching ${SEGMENT_RE.source}; '/', '\\', '?', '#', spaces and traversal segments are forbidden`);
    }
    return segment;
}
function categoryPathFromUri(uri) {
    const prefix = `${RESOURCE_TAXONOMY_ROOT_URI}/`;
    if (!uri.startsWith(prefix) || uri.length <= prefix.length) {
        throw new Error(`resource taxonomy category URI is outside ${RESOURCE_TAXONOMY_ROOT_URI}: ${uri}`);
    }
    return uri.slice(prefix.length);
}
function renderCategoryEmbeddingText(path, description, ancestors) {
    const lines = [`description: ${description}`];
    if (ancestors.length > 0) {
        lines.push(`ancestors: ${ancestors.map((ancestor) => `${ancestor.path}: ${ancestor.description}`).join(" > ")}`);
    }
    lines.push(`path: ${path}`);
    return lines.join("\n");
}
function renderCategoryRerankText(embeddingText, distinguishFrom, ancestors) {
    const inherited = ancestors.flatMap((ancestor) => ancestor.distinguishFrom.map((hint) => `${ancestor.path}: ${hint}`));
    const hints = [...inherited, ...distinguishFrom];
    if (hints.length === 0) {
        return embeddingText;
    }
    return `${embeddingText}\ndistinguishFrom: ${hints.join(" | ")}`;
}
function canonicalRoutingData(fallbackKey, categories) {
    const canonicalCategories = [...categories]
        .sort((left, right) => left.key.localeCompare(right.key))
        .map(({ key, segment, description, distinguishFrom, routeable, uri, path, embeddingText, rerankText, parentKey, depth }) => ({
        key,
        segment,
        description,
        distinguishFrom,
        routeable,
        uri,
        path,
        embeddingText,
        rerankText,
        parentKey,
        depth,
    }));
    return JSON.stringify({
        schemaVersion: RESOURCE_TAXONOMY_SCHEMA_VERSION,
        fallback: fallbackKey,
        categories: canonicalCategories,
    });
}
export function compileResourceTaxonomy(value) {
    assertRecord(value, "resource taxonomy");
    assertAllowedKeys(value, TAXONOMY_KEYS, "resource taxonomy");
    if (value.schemaVersion !== RESOURCE_TAXONOMY_SCHEMA_VERSION) {
        throw new Error(`resource taxonomy schemaVersion must be ${RESOURCE_TAXONOMY_SCHEMA_VERSION}`);
    }
    const fallbackKey = parseSemanticKey(parseNonEmptyString(value.fallback, "resource taxonomy fallback", 128), "resource taxonomy fallback");
    assertRecord(value.categories, "resource taxonomy categories");
    const rootEntries = Object.entries(value.categories);
    if (rootEntries.length === 0) {
        throw new Error("resource taxonomy categories must not be empty");
    }
    const pending = rootEntries
        .slice()
        .reverse()
        .map(([key, raw]) => ({
        key,
        raw,
        parentKey: null,
        parentUri: RESOURCE_TAXONOMY_ROOT_URI,
        depth: 1,
        ancestors: [],
    }));
    const categories = [];
    const byKey = new Map();
    const byPath = new Map();
    const seenUris = new Map();
    while (pending.length > 0) {
        const current = pending.pop();
        const key = parseSemanticKey(current.key, `resource taxonomy category key ${JSON.stringify(current.key)}`);
        if (byKey.has(key)) {
            throw new Error(`resource taxonomy semantic key ${JSON.stringify(key)} is duplicated`);
        }
        assertRecord(current.raw, `resource taxonomy category ${JSON.stringify(key)}`);
        assertAllowedKeys(current.raw, CATEGORY_KEYS, `resource taxonomy category ${JSON.stringify(key)}`);
        const segment = parseSegment(current.raw.segment, `resource taxonomy category ${JSON.stringify(key)} segment`);
        const description = parseNonEmptyString(current.raw.description, `resource taxonomy category ${JSON.stringify(key)} description`, MAX_DESCRIPTION_CHARS);
        const distinguishFrom = parseOptionalStringList(current.raw.distinguishFrom, `resource taxonomy category ${JSON.stringify(key)} distinguishFrom`);
        if (current.raw.routeable !== undefined && typeof current.raw.routeable !== "boolean") {
            throw new Error(`resource taxonomy category ${JSON.stringify(key)} routeable must be a boolean`);
        }
        const routeable = current.raw.routeable !== false;
        const uri = `${current.parentUri}/${segment}`;
        const collidingKey = seenUris.get(uri);
        if (collidingKey) {
            throw new Error(`resource taxonomy categories ${JSON.stringify(collidingKey)} and ${JSON.stringify(key)} resolve to the same URI ${uri}`);
        }
        const path = categoryPathFromUri(uri);
        const embeddingText = renderCategoryEmbeddingText(path, description, current.ancestors);
        const rerankText = renderCategoryRerankText(embeddingText, distinguishFrom, current.ancestors);
        const compiled = {
            key,
            segment,
            description,
            distinguishFrom,
            routeable,
            uri,
            path,
            embeddingText,
            rerankText,
            parentKey: current.parentKey,
            depth: current.depth,
        };
        categories.push(compiled);
        byKey.set(key, compiled);
        byPath.set(path, compiled);
        seenUris.set(uri, key);
        if (current.raw.children !== undefined) {
            assertRecord(current.raw.children, `resource taxonomy category ${JSON.stringify(key)} children`);
            const children = Object.entries(current.raw.children);
            const childAncestors = [
                ...current.ancestors,
                { path, description, distinguishFrom },
            ];
            for (let index = children.length - 1; index >= 0; index -= 1) {
                const [childKey, childRaw] = children[index];
                pending.push({
                    key: childKey,
                    raw: childRaw,
                    parentKey: key,
                    parentUri: uri,
                    depth: current.depth + 1,
                    ancestors: childAncestors,
                });
            }
        }
    }
    const fallback = byKey.get(fallbackKey);
    if (!fallback) {
        throw new Error(`resource taxonomy fallback ${JSON.stringify(fallbackKey)} does not reference an existing category`);
    }
    if (!fallback.routeable) {
        throw new Error(`resource taxonomy fallback ${JSON.stringify(fallbackKey)} must reference a routeable category`);
    }
    const routeableCategories = categories.filter((category) => category.routeable);
    if (routeableCategories.length === 0) {
        throw new Error("resource taxonomy must contain at least one routeable category");
    }
    const semanticCategories = routeableCategories.filter((category) => category.key !== fallbackKey);
    if (semanticCategories.length === 0) {
        throw new Error("resource taxonomy must contain at least one routeable semantic category besides the fallback");
    }
    const taxonomyHash = createHash("sha256")
        .update(canonicalRoutingData(fallbackKey, categories), "utf8")
        .digest("hex");
    return {
        schemaVersion: RESOURCE_TAXONOMY_SCHEMA_VERSION,
        fallbackKey,
        fallbackUri: fallback.uri,
        taxonomyHash,
        categories,
        routeableCategories,
        semanticCategories,
        byKey,
        byPath,
    };
}
export function parseResourceTaxonomyYaml(text, sourceLabel = "resource taxonomy YAML") {
    if (typeof text !== "string" || !text.trim()) {
        throw new Error(`${sourceLabel} must not be empty`);
    }
    const document = parseDocument(text, {
        schema: "core",
        uniqueKeys: true,
    });
    if (document.errors.length > 0) {
        const details = document.errors.map((error) => error.message).join("; ");
        throw new Error(`${sourceLabel} is invalid YAML: ${details}`);
    }
    let parsed;
    try {
        parsed = document.toJS({ maxAliasCount: 0 });
    }
    catch (error) {
        throw new Error(`${sourceLabel} could not be converted safely: ${error instanceof Error ? error.message : String(error)}`);
    }
    return compileResourceTaxonomy(parsed);
}
export function loadResourceTaxonomyFile(filePath) {
    let text;
    try {
        text = readFileSync(filePath, "utf8");
    }
    catch (error) {
        throw new Error(`resource taxonomy file ${JSON.stringify(filePath)} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseResourceTaxonomyYaml(text, `resource taxonomy file ${JSON.stringify(filePath)}`);
}
export function resolvePerAgentFileTemplate(template, agentId) {
    const normalizedTemplate = parseNonEmptyString(template, "resource routing file template");
    const normalizedAgentId = parseNonEmptyString(agentId, "resource routing agentId", 128);
    if (!SEMANTIC_KEY_RE.test(normalizedAgentId)) {
        throw new Error("resource routing agentId contains unsafe characters; only letters, digits, '.', '_' and '-' are allowed");
    }
    if (!normalizedTemplate.includes("{agentId}")) {
        throw new Error("resource routing file template must contain {agentId}");
    }
    const expandedTemplate = normalizedTemplate === "~"
        ? homedir()
        : normalizedTemplate.startsWith("~/")
            ? `${homedir()}${normalizedTemplate.slice(1)}`
            : normalizedTemplate;
    const resolved = expandedTemplate.replaceAll("{agentId}", normalizedAgentId);
    if (!isAbsolute(resolved)) {
        throw new Error("resource routing file template must resolve to an absolute path");
    }
    return resolved;
}
