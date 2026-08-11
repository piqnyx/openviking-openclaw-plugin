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

describe("Russian resource taxonomy", () => {
  it("keeps structural parents non-routeable and exposes only semantic leaves", () => {
    expect(taxonomy.categories.length).toBe(275);
    expect(taxonomy.routeableCategories.length).toBe(224);
    for (const key of ["mine", "docs", "code", "code-source", "web", "comms", "data", "archives", "security"]) {
      expect(taxonomy.byKey.get(key)?.routeable, key).toBe(false);
    }
  });

  it("keeps the visible fallback inbox and expected JavaScript source URI", () => {
    expect(taxonomy.fallbackKey).toBe("inbox");
    expect(taxonomy.fallbackUri).toBe("viking://resources/_INBOX");
    expect(taxonomy.byKey.get("code-source-javascript")?.uri).toBe(
      "viking://resources/code/source/javascript",
    );
  });

  it("uses Russian descriptions for every category", () => {
    for (const category of taxonomy.categories) {
      expect(category.description, category.key).toMatch(/[А-Яа-яЁё]/u);
    }
  });

  it("keeps every labeled routing case pointed at an existing routeable category", () => {
    expect(cases.length).toBeGreaterThanOrEqual(70);
    for (const testCase of cases) {
      expect(testCase.summary, testCase.id).toMatch(/[А-Яа-яЁё]/u);
      const expected = Array.isArray(testCase.expected) ? testCase.expected : [testCase.expected];
      for (const key of expected) {
        expect(taxonomy.byKey.get(key)?.routeable, `${testCase.id}: ${key}`).toBe(true);
      }
    }
  });
});
