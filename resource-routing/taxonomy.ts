import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

const RESOURCE_ROOT = "viking://resources";
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEGMENT_RE = /^[\p{L}\p{N}\p{M}_.-]+$/u;

export type ResourceTaxonomyNodeInput = {
  segment?: unknown;
  description?: unknown;
  routeable?: unknown;
  children?: unknown;
};

export type ResourceTaxonomyDocumentInput = {
  schemaVersion?: unknown;
  categories?: unknown;
};

export type ResourceTaxonomyCategory = {
  key: string;
  segment: string;
  description: string;
  routeable: boolean;
  parentKey?: string;
  depth: number;
  uri: string;
};

export type ResourceTaxonomy = {
  schemaVersion: 1;
  categories: ResourceTaxonomyCategory[];
  byKey: ReadonlyMap<string, ResourceTaxonomyCategory>;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
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

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function validateKey(key: string, label: string): void {
  if (!KEY_RE.test(key)) {
    throw new Error(`${label} must match ${KEY_RE}`);
  }
}

function validateSegment(segment: string, label: string): void {
  if (segment === "." || segment === ".." || !SEGMENT_RE.test(segment)) {
    throw new Error(`${label} is not a safe resource URI segment`);
  }
  if (Array.from(segment).length > 50) {
    throw new Error(`${label} must be at most 50 characters`);
  }
}

function parseRouteable(value: unknown, label: string): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

export function parseResourceTaxonomy(value: unknown): ResourceTaxonomy {
  const root = asRecord(value, "resource taxonomy");
  assertAllowedKeys(root, ["schemaVersion", "categories"], "resource taxonomy");

  if (root.schemaVersion !== 1) {
    throw new Error("resource taxonomy schemaVersion must be 1");
  }

  const categoriesRecord = asRecord(root.categories, "resource taxonomy categories");
  if (Object.keys(categoriesRecord).length === 0) {
    throw new Error("resource taxonomy categories must not be empty");
  }

  const categories: ResourceTaxonomyCategory[] = [];
  const byKey = new Map<string, ResourceTaxonomyCategory>();
  const byUri = new Set<string>();

  const visit = (
    key: string,
    rawNode: unknown,
    parentUri: string,
    parentKey: string | undefined,
    depth: number,
  ): void => {
    validateKey(key, `resource taxonomy category key ${JSON.stringify(key)}`);
    if (byKey.has(key)) {
      throw new Error(`resource taxonomy contains duplicate category key: ${key}`);
    }

    const node = asRecord(rawNode, `resource taxonomy category ${key}`);
    assertAllowedKeys(node, ["segment", "description", "routeable", "children"], `resource taxonomy category ${key}`);

    const segment = requireString(node.segment, `resource taxonomy category ${key}.segment`);
    validateSegment(segment, `resource taxonomy category ${key}.segment`);
    const description = requireString(node.description, `resource taxonomy category ${key}.description`);
    const routeable = parseRouteable(node.routeable, `resource taxonomy category ${key}.routeable`);
    const uri = `${parentUri}/${segment}`;
    if (byUri.has(uri)) {
      throw new Error(`resource taxonomy contains duplicate destination URI: ${uri}`);
    }
    byUri.add(uri);

    const category: ResourceTaxonomyCategory = {
      key,
      segment,
      description,
      routeable,
      parentKey,
      depth,
      uri,
    };
    categories.push(category);
    byKey.set(key, category);

    if (node.children !== undefined) {
      const children = asRecord(node.children, `resource taxonomy category ${key}.children`);
      for (const [childKey, childNode] of Object.entries(children)) {
        visit(childKey, childNode, uri, key, depth + 1);
      }
    }
  };

  for (const [key, node] of Object.entries(categoriesRecord)) {
    visit(key, node, RESOURCE_ROOT, undefined, 0);
  }

  return {
    schemaVersion: 1,
    categories,
    byKey,
  };
}

export function parseResourceTaxonomyYaml(text: string): ResourceTaxonomy {
  let parsed: unknown;
  try {
    parsed = parseYaml(text, { uniqueKeys: true });
  } catch (error) {
    throw new Error(`resource taxonomy YAML parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseResourceTaxonomy(parsed);
}

export async function loadResourceTaxonomyFile(filePath: string): Promise<ResourceTaxonomy> {
  const resolvedPath = resolve(filePath);
  let text: string;
  try {
    text = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(`resource taxonomy file could not be read (${resolvedPath}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseResourceTaxonomyYaml(text);
}

export function resolveResourceCategoryUri(taxonomy: ResourceTaxonomy, categoryKey: string): string {
  const category = taxonomy.byKey.get(categoryKey);
  if (!category) {
    throw new Error(`resource routing selected unknown category: ${categoryKey}`);
  }
  if (!category.routeable) {
    throw new Error(`resource routing selected non-routeable category: ${categoryKey}`);
  }
  return category.uri;
}

export function assertResourceRoutingFallbackCategory(taxonomy: ResourceTaxonomy, categoryKey: string): void {
  const category = taxonomy.byKey.get(categoryKey);
  if (!category) {
    throw new Error(`resource routing fallback category does not exist in taxonomy: ${categoryKey}`);
  }
  if (!category.routeable) {
    throw new Error(`resource routing fallback category must be routeable: ${categoryKey}`);
  }
}

export function listRouteableResourceCategories(taxonomy: ResourceTaxonomy): ResourceTaxonomyCategory[] {
  return taxonomy.categories.filter((category) => category.routeable);
}
