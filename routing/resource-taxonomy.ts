import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

import { parseDocument } from "yaml";

export const RESOURCE_TAXONOMY_SCHEMA_VERSION = 1 as const;
export const RESOURCE_TAXONOMY_ROOT_URI = "viking://resources" as const;

const CATEGORY_KEYS = ["segment", "description", "routeable", "children"] as const;
const TAXONOMY_KEYS = ["schemaVersion", "fallback", "categories"] as const;
const SEMANTIC_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MAX_DESCRIPTION_CHARS = 4_000;

export type ResourceTaxonomyCategoryNode = {
  segment: string;
  description: string;
  routeable?: boolean;
  children?: Record<string, ResourceTaxonomyCategoryNode>;
};

export type ResourceTaxonomyDocument = {
  schemaVersion: typeof RESOURCE_TAXONOMY_SCHEMA_VERSION;
  fallback: string;
  categories: Record<string, ResourceTaxonomyCategoryNode>;
};

export type CompiledResourceCategory = {
  key: string;
  segment: string;
  description: string;
  routeable: boolean;
  uri: string;
  path: string;
  routingText: string;
  parentKey: string | null;
  depth: number;
};

export type CompiledResourceTaxonomy = {
  schemaVersion: typeof RESOURCE_TAXONOMY_SCHEMA_VERSION;
  fallbackKey: string;
  fallbackUri: string;
  taxonomyHash: string;
  categories: readonly CompiledResourceCategory[];
  routeableCategories: readonly CompiledResourceCategory[];
  semanticCategories: readonly CompiledResourceCategory[];
  byKey: ReadonlyMap<string, CompiledResourceCategory>;
  byPath: ReadonlyMap<string, CompiledResourceCategory>;
};

type RoutingAncestor = {
  path: string;
  description: string;
};

type PendingCategory = {
  key: string;
  raw: unknown;
  parentKey: string | null;
  parentUri: string;
  depth: number;
  ancestors: readonly RoutingAncestor[];
};

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

function parseNonEmptyString(value: unknown, label: string, maxChars = Number.POSITIVE_INFINITY): string {
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

function parseSemanticKey(value: string, label: string): string {
  if (!SEMANTIC_KEY_RE.test(value)) {
    throw new Error(
      `${label} must match ${SEMANTIC_KEY_RE.source}; use a stable semantic key without spaces or path separators`,
    );
  }
  return value;
}

function parseSegment(value: unknown, label: string): string {
  const segment = parseNonEmptyString(value, label, 128);
  if (segment === "." || segment === ".." || !SEGMENT_RE.test(segment)) {
    throw new Error(
      `${label} must be one safe URI segment matching ${SEGMENT_RE.source}; '/', '\\', '?', '#', spaces and traversal segments are forbidden`,
    );
  }
  return segment;
}

function categoryPathFromUri(uri: string): string {
  const prefix = `${RESOURCE_TAXONOMY_ROOT_URI}/`;
  if (!uri.startsWith(prefix) || uri.length <= prefix.length) {
    throw new Error(`resource taxonomy category URI is outside ${RESOURCE_TAXONOMY_ROOT_URI}: ${uri}`);
  }
  return uri.slice(prefix.length);
}

function renderCategoryRoutingText(
  path: string,
  description: string,
  ancestors: readonly RoutingAncestor[],
): string {
  const lines = [`description: ${description}`];
  if (ancestors.length > 0) {
    lines.push(
      `ancestors: ${ancestors.map((ancestor) => `${ancestor.path}: ${ancestor.description}`).join(" > ")}`,
    );
  }
  lines.push(`path: ${path}`);
  return lines.join("\n");
}

function canonicalRoutingData(
  fallbackKey: string,
  categories: readonly CompiledResourceCategory[],
): string {
  const canonicalCategories = [...categories]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ key, segment, description, routeable, uri, path, routingText, parentKey, depth }) => ({
      key,
      segment,
      description,
      routeable,
      uri,
      path,
      routingText,
      parentKey,
      depth,
    }));

  return JSON.stringify({
    schemaVersion: RESOURCE_TAXONOMY_SCHEMA_VERSION,
    fallback: fallbackKey,
    categories: canonicalCategories,
  });
}

export function compileResourceTaxonomy(value: unknown): CompiledResourceTaxonomy {
  assertRecord(value, "resource taxonomy");
  assertAllowedKeys(value, TAXONOMY_KEYS, "resource taxonomy");

  if (value.schemaVersion !== RESOURCE_TAXONOMY_SCHEMA_VERSION) {
    throw new Error(
      `resource taxonomy schemaVersion must be ${RESOURCE_TAXONOMY_SCHEMA_VERSION}`,
    );
  }

  const fallbackKey = parseSemanticKey(
    parseNonEmptyString(value.fallback, "resource taxonomy fallback", 128),
    "resource taxonomy fallback",
  );

  assertRecord(value.categories, "resource taxonomy categories");
  const rootEntries = Object.entries(value.categories);
  if (rootEntries.length === 0) {
    throw new Error("resource taxonomy categories must not be empty");
  }

  const pending: PendingCategory[] = rootEntries
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

  const categories: CompiledResourceCategory[] = [];
  const byKey = new Map<string, CompiledResourceCategory>();
  const byPath = new Map<string, CompiledResourceCategory>();
  const seenUris = new Map<string, string>();

  while (pending.length > 0) {
    const current = pending.pop()!;
    const key = parseSemanticKey(current.key, `resource taxonomy category key ${JSON.stringify(current.key)}`);
    if (byKey.has(key)) {
      throw new Error(`resource taxonomy semantic key ${JSON.stringify(key)} is duplicated`);
    }

    assertRecord(current.raw, `resource taxonomy category ${JSON.stringify(key)}`);
    assertAllowedKeys(
      current.raw,
      CATEGORY_KEYS,
      `resource taxonomy category ${JSON.stringify(key)}`,
    );

    const segment = parseSegment(
      current.raw.segment,
      `resource taxonomy category ${JSON.stringify(key)} segment`,
    );
    const description = parseNonEmptyString(
      current.raw.description,
      `resource taxonomy category ${JSON.stringify(key)} description`,
      MAX_DESCRIPTION_CHARS,
    );
    if (current.raw.routeable !== undefined && typeof current.raw.routeable !== "boolean") {
      throw new Error(`resource taxonomy category ${JSON.stringify(key)} routeable must be a boolean`);
    }
    const routeable = current.raw.routeable !== false;
    const uri = `${current.parentUri}/${segment}`;
    const collidingKey = seenUris.get(uri);
    if (collidingKey) {
      throw new Error(
        `resource taxonomy categories ${JSON.stringify(collidingKey)} and ${JSON.stringify(key)} resolve to the same URI ${uri}`,
      );
    }
    const path = categoryPathFromUri(uri);
    const routingText = renderCategoryRoutingText(path, description, current.ancestors);

    const compiled: CompiledResourceCategory = {
      key,
      segment,
      description,
      routeable,
      uri,
      path,
      routingText,
      parentKey: current.parentKey,
      depth: current.depth,
    };
    categories.push(compiled);
    byKey.set(key, compiled);
    byPath.set(path, compiled);
    seenUris.set(uri, key);

    if (current.raw.children !== undefined) {
      assertRecord(
        current.raw.children,
        `resource taxonomy category ${JSON.stringify(key)} children`,
      );
      const children = Object.entries(current.raw.children);
      const childAncestors = [
        ...current.ancestors,
        { path, description },
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
    throw new Error(
      `resource taxonomy fallback ${JSON.stringify(fallbackKey)} does not reference an existing category`,
    );
  }
  if (!fallback.routeable) {
    throw new Error(
      `resource taxonomy fallback ${JSON.stringify(fallbackKey)} must reference a routeable category`,
    );
  }

  const routeableCategories = categories.filter((category) => category.routeable);
  if (routeableCategories.length === 0) {
    throw new Error("resource taxonomy must contain at least one routeable category");
  }
  const semanticCategories = routeableCategories.filter((category) => category.key !== fallbackKey);
  if (semanticCategories.length === 0) {
    throw new Error(
      "resource taxonomy must contain at least one routeable semantic category besides the fallback",
    );
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

export function parseResourceTaxonomyYaml(
  text: string,
  sourceLabel = "resource taxonomy YAML",
): CompiledResourceTaxonomy {
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

  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(
      `${sourceLabel} could not be converted safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return compileResourceTaxonomy(parsed);
}

export function loadResourceTaxonomyFile(filePath: string): CompiledResourceTaxonomy {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `resource taxonomy file ${JSON.stringify(filePath)} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseResourceTaxonomyYaml(text, `resource taxonomy file ${JSON.stringify(filePath)}`);
}

export function resolvePerAgentFileTemplate(template: string, agentId: string): string {
  const normalizedTemplate = parseNonEmptyString(template, "resource routing file template");
  const normalizedAgentId = parseNonEmptyString(agentId, "resource routing agentId", 128);
  if (!SEMANTIC_KEY_RE.test(normalizedAgentId)) {
    throw new Error(
      "resource routing agentId contains unsafe characters; only letters, digits, '.', '_' and '-' are allowed",
    );
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
