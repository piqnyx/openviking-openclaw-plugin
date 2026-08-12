import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseResourceTaxonomyYaml } from "../routing/resource-taxonomy.js";

const taxonomyText = readFileSync("examples/resource-taxonomy.ru.yaml", "utf8");
const taxonomy = parseResourceTaxonomyYaml(taxonomyText, "Russian resource taxonomy");
const cases = JSON.parse(readFileSync("examples/routing-cases.ru.json", "utf8")) as Array<{
  id: string;
  summary: string;
  expected: string | string[];
}>;

const parentKeys = new Set(
  taxonomy.categories
    .map((category) => category.parentKey)
    .filter((key): key is string => Boolean(key)),
);

describe("Russian resource taxonomy", () => {
  it("pins the reviewed deep-tree shape", () => {
    expect(taxonomy.categories.length).toBe(394);
    expect(taxonomy.routeableCategories.length).toBe(310);
    expect(taxonomy.semanticCategories.length).toBe(309);
    expect(cases).toHaveLength(137);
    expect(Math.max(...taxonomy.categories.map((category) => category.depth))).toBe(4);

    expect(
      taxonomy.categories.filter((category) => category.depth === 1).map((category) => category.path),
    ).toEqual([
      "_INBOX",
      "mine",
      "docs",
      "code",
      "web",
      "comms",
      "data",
      "archives",
      "security",
    ]);
    expect(taxonomy.byKey.has("media")).toBe(false);
  });

  it("keeps every structural parent non-routeable and every semantic category a leaf", () => {
    const structural = taxonomy.categories.filter((category) => parentKeys.has(category.key));
    expect(structural).toHaveLength(84);
    for (const category of structural) {
      expect(category.routeable, `${category.key} [${category.path}]`).toBe(false);
    }
    for (const category of taxonomy.semanticCategories) {
      expect(parentKeys.has(category.key), `${category.key} [${category.path}]`).toBe(false);
    }
  });

  it("keeps fallback writable but completely outside semantic ranking", () => {
    expect(taxonomy.fallbackKey).toBe("inbox");
    expect(taxonomy.fallbackUri).toBe("viking://resources/_INBOX");
    expect(taxonomy.byKey.get("inbox")?.routeable).toBe(true);
    expect(taxonomy.semanticCategories.some((category) => category.key === "inbox")).toBe(false);
  });

  it("keeps exact full paths for repeated segment names", () => {
    expect(taxonomy.byKey.get("code-source-javascript")?.path).toBe("code/source/javascript");
    expect(taxonomy.byKey.get("code-source-javascript")?.uri).toBe(
      "viking://resources/code/source/javascript",
    );
    for (const category of taxonomy.categories) {
      expect(taxonomy.byPath.get(category.path)?.key).toBe(category.key);
    }
  });

  it("uses substantive Russian descriptions and positive ancestry-aware embedding text for every category", () => {
    for (const category of taxonomy.categories) {
      expect(category.description, category.key).toMatch(/[А-Яа-яЁё]/u);
      expect(category.description.trim().length, category.key).toBeGreaterThanOrEqual(24);
      expect(category.embeddingText, category.key).toContain(`description: ${category.description}`);
      expect(category.embeddingText, category.key).toContain(`path: ${category.path}`);
      if (category.parentKey) {
        expect(category.embeddingText, category.key).toContain("ancestors:");
      }
      for (const boundary of category.distinguishFrom) {
        expect(category.embeddingText, `${category.key}: ${boundary}`).not.toContain(boundary);
        expect(category.rerankText, `${category.key}: ${boundary}`).toContain(boundary);
      }
    }
  });

  it("has no exact duplicate normalized descriptions", () => {
    const seen = new Map<string, string>();
    for (const category of taxonomy.categories) {
      const normalized = category.description
        .normalize("NFC")
        .toLocaleLowerCase("ru")
        .replace(/\s+/g, " ")
        .trim();
      const previous = seen.get(normalized);
      expect(previous, `${category.key} duplicates ${previous ?? ""}`).toBeUndefined();
      seen.set(normalized, category.key);
    }
  });

  it("keeps every labeled routing case pointed at an existing writable category", () => {
    for (const testCase of cases) {
      expect(testCase.summary, testCase.id).toMatch(/[А-Яа-яЁё]/u);
      const expected = Array.isArray(testCase.expected) ? testCase.expected : [testCase.expected];
      for (const key of expected) {
        expect(taxonomy.byKey.get(key)?.routeable, `${testCase.id}: ${key}`).toBe(true);
      }
    }
  });
});
