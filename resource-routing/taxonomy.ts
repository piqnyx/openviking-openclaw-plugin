import { createHash } from "node:crypto";

import { parseDocument } from "yaml";

const RESOURCE_ROOT_URI = "viking://resources";
const TAXONOMY_SCHEMA_VERSION = 1;
const MAX_TAXONOMY_BYTES = 1_048_576;
const SEMANTIC_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export type CompiledResourceCategory = {
  key: string;
  segment: string;
  description: string;
  routeable: boolean;
  parentKey?: string;
  ancestorKeys: string[];
  pathSegments: string[];
  uri: string;
};

export type CompiledResourceTaxonomy = {
  schemaVersion: 1;
  taxonomyHash: string;
  categories: CompiledResourceCategory[];
  routeableCategories: CompiledResourceCategory[];
  byKey: ReadonlyMap<string, CompiledResourceCategory>;
};

type TaxonomyRoot = {
  schemaVersion: unknown;
  categories: unknown;
};

type PendingCategory = {
  key: string;
  value: unknown;
  parentKey?: string;
  ancestorKeys: string[];
  parentSegments: string[];
};

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping/object`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

function semanticKey(value: string, label: string): string {
  if (!SEMANTIC_KEY_PATTERN.test(value)) {
    throw new Error(`${label} must match [a-z0-9][a-z0-9._-]* and be at most 128 characters`);
  }
  return value;
}

function segmentValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not have leading or trailing whitespace`);
  }
  if (!SEGMENT_PATTERN.test(value)) {
    throw new Error(
      `${label} must be one safe URI segment using only letters, digits, "_", ".", or "-"`,
    );
  }
  if (value === "." || value === "..") {
    throw new Error(`${label} must not be "." or ".."`);
  }
  return value;
}

function descriptionValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const description = value.trim();
  if (!description) {
    throw new Error(`${label} must not be empty`);
  }
  if (description.length > 4_000) {
    throw new Error(`${label} must not exceed 4000 characters`);
  }
  return description;
}

function routeableValue(value: unknown, label: string): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function parseYaml(text: string, sourceLabel: string): TaxonomyRoot {
  if (Buffer.byteLength(text, "utf8") > MAX_TAXONOMY_BYTES) {
    throw new Error(`${sourceLabel}: taxonomy exceeds the 1 MiB safety limit`);
  }
  const document = parseDocument(text, {
    uniqueKeys: true,
    merge: false,
    prettyErrors: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${sourceLabel}: invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  if (document.warnings.length > 0) {
    throw new Error(
      `${sourceLabel}: YAML warnings are not accepted: ${document.warnings.map((warning) => warning.message).join("; ")}`,
    );
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (err) {
    throw new Error(
      `${sourceLabel}: YAML aliases/anchors are not accepted (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const root = plainRecord(value, `${sourceLabel}: root`);
  assertAllowedKeys(root, ["schemaVersion", "categories"], `${sourceLabel}: root`);
  return {
    schemaVersion: root.schemaVersion,
    categories: root.categories,
  };
}

function taxonomyHash(schemaVersion: 1, categories: CompiledResourceCategory[]): string {
  const canonicalCategories = [...categories]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((category) => ({
      key: category.key,
      segment: category.segment,
      description: category.description,
      routeable: category.routeable,
      parentKey: category.parentKey ?? null,
      ancestorKeys: category.ancestorKeys,
      pathSegments: category.pathSegments,
      uri: category.uri,
    }));
  const canonical = JSON.stringify({
    schemaVersion,
    categories: canonicalCategories,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function compileResourceTaxonomy(
  value: unknown,
  sourceLabel = "resource taxonomy",
): CompiledResourceTaxonomy {
  const root = plainRecord(value, `${sourceLabel}: root`);
  assertAllowedKeys(root, ["schemaVersion", "categories"], `${sourceLabel}: root`);
  if (root.schemaVersion !== TAXONOMY_SCHEMA_VERSION) {
    throw new Error(`${sourceLabel}: schemaVersion must be ${TAXONOMY_SCHEMA_VERSION}`);
  }
  const rootCategories = plainRecord(root.categories, `${sourceLabel}: categories`);
  const rootEntries = Object.entries(rootCategories);
  if (rootEntries.length === 0) {
    throw new Error(`${sourceLabel}: categories must not be empty`);
  }

  const categories: CompiledResourceCategory[] = [];
  const byKey = new Map<string, CompiledResourceCategory>();
  const seenUris = new Map<string, string>();
  const pending: PendingCategory[] = rootEntries
    .slice()
    .reverse()
    .map(([key, category]) => ({
      key,
      value: category,
      ancestorKeys: [],
      parentSegments: [],
    }));

  while (pending.length > 0) {
    const current = pending.pop()!;
    const key = semanticKey(
      current.key,
      `${sourceLabel}: category key ${JSON.stringify(current.key)}`,
    );
    if (byKey.has(key)) {
      throw new Error(
        `${sourceLabel}: semantic category key ${JSON.stringify(key)} is defined more than once`,
      );
    }
    const raw = plainRecord(current.value, `${sourceLabel}: category ${key}`);
    assertAllowedKeys(
      raw,
      ["segment", "description", "routeable", "children"],
      `${sourceLabel}: category ${key}`,
    );
    const segment = segmentValue(raw.segment, `${sourceLabel}: category ${key}.segment`);
    const description = descriptionValue(
      raw.description,
      `${sourceLabel}: category ${key}.description`,
    );
    const routeable = routeableValue(raw.routeable, `${sourceLabel}: category ${key}.routeable`);
    const pathSegments = [...current.parentSegments, segment];
    const uri = `${RESOURCE_ROOT_URI}/${pathSegments.join("/")}`;
    const existingUriOwner = seenUris.get(uri);
    if (existingUriOwner) {
      throw new Error(
        `${sourceLabel}: categories ${JSON.stringify(existingUriOwner)} and ${JSON.stringify(key)} resolve to the same URI ${uri}`,
      );
    }
    const category: CompiledResourceCategory = {
      key,
      segment,
      description,
      routeable,
      parentKey: current.parentKey,
      ancestorKeys: current.ancestorKeys,
      pathSegments,
      uri,
    };
    categories.push(category);
    byKey.set(key, category);
    seenUris.set(uri, key);

    if (raw.children !== undefined) {
      const children = plainRecord(raw.children, `${sourceLabel}: category ${key}.children`);
      const childEntries = Object.entries(children);
      for (let index = childEntries.length - 1; index >= 0; index -= 1) {
        const [childKey, childValue] = childEntries[index]!;
        pending.push({
          key: childKey,
          value: childValue,
          parentKey: key,
          ancestorKeys: [...current.ancestorKeys, key],
          parentSegments: pathSegments,
        });
      }
    }
  }

  const routeableCategories = categories.filter((category) => category.routeable);
  if (routeableCategories.length === 0) {
    throw new Error(`${sourceLabel}: taxonomy has no routeable categories`);
  }

  return {
    schemaVersion: TAXONOMY_SCHEMA_VERSION,
    taxonomyHash: taxonomyHash(TAXONOMY_SCHEMA_VERSION, categories),
    categories,
    routeableCategories,
    byKey,
  };
}

export function resolveResourceTaxonomyCategory(
  taxonomy: CompiledResourceTaxonomy,
  key: string,
  label = "resource routing category",
): CompiledResourceCategory {
  const normalizedKey = semanticKey(key.trim(), label);
  const category = taxonomy.byKey.get(normalizedKey);
  if (!category) {
    throw new Error(`${label} ${JSON.stringify(normalizedKey)} does not exist in the taxonomy`);
  }
  if (!category.routeable) {
    throw new Error(`${label} ${JSON.stringify(normalizedKey)} is not routeable`);
  }
  return category;
}

export function parseResourceTaxonomyYaml(
  text: string,
  sourceLabel = "resource taxonomy",
): CompiledResourceTaxonomy {
  const root = parseYaml(text, sourceLabel);
  return compileResourceTaxonomy(root, sourceLabel);
}
