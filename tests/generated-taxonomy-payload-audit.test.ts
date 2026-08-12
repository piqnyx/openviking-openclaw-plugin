import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { parseResourceTaxonomyYaml } from "../routing/resource-taxonomy.js";

function extractString(source: string, name: string): string {
  const triple = new RegExp(`${name}\\s*=\\s*\"\"\"([\\s\\S]*?)\"\"\"`).exec(source)?.[1];
  if (triple !== undefined) return triple.trim();
  const single = new RegExp(`${name}\\s*=\\s*\"([^\"]+)\"`).exec(source)?.[1];
  if (single !== undefined) return single;
  throw new Error(`Could not extract ${name} from taxonomy generator`);
}

function normalize(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("ru")
    .replace(/[\\p{P}\\p{S}]+/gu, " ")
    .replace(/\\s+/g, " ")
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter((token) => token.length >= 3));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection || 1);
}

type Refinements = {
  descriptionReplacements: Array<{ old: string; new: string }>;
  additionalCases: Array<{
    id: string;
    summary: string;
    expected: string | string[];
    note?: string;
  }>;
};

describe("embedded Russian taxonomy payload audit", () => {
  it("validates the exact payload after all reviewed refinements", () => {
    const generator = readFileSync("tools/apply-russian-routing-taxonomy.py", "utf8");
    const expectedSourceSha = extractString(generator, "TAXONOMY_SHA256");
    const payload = extractString(generator, "TAXONOMY_GZIP_B64").replace(/\\s+/g, "");
    const sourceYaml = gunzipSync(Buffer.from(payload, "base64")).toString("utf8");
    const sourceSha = createHash("sha256").update(sourceYaml, "utf8").digest("hex");
    expect(sourceSha).toBe(expectedSourceSha);

    const casesPayload = extractString(generator, "CASES_GZIP_B64").replace(/\\s+/g, "");
    const cases = JSON.parse(gunzipSync(Buffer.from(casesPayload, "base64")).toString("utf8")) as Refinements["additionalCases"];
    const refinements = JSON.parse(
      readFileSync("tools/russian-taxonomy-refinements.json", "utf8"),
    ) as Refinements;

    let yaml = sourceYaml;
    for (const replacement of refinements.descriptionReplacements) {
      expect(yaml.split(replacement.old).length - 1, replacement.old).toBe(1);
      yaml = yaml.replace(replacement.old, replacement.new);
    }
    const existingIds = new Set(cases.map((entry) => entry.id));
    for (const testCase of refinements.additionalCases) {
      expect(existingIds.has(testCase.id), testCase.id).toBe(false);
      existingIds.add(testCase.id);
      cases.push(testCase);
    }

    const finalSha = createHash("sha256").update(yaml, "utf8").digest("hex");
    const taxonomy = parseResourceTaxonomyYaml(yaml, "refined Russian resource taxonomy");
    const parentKeys = new Set(
      taxonomy.categories.map((category) => category.parentKey).filter(Boolean),
    );

    const exact = new Map<string, string[]>();
    for (const category of taxonomy.categories) {
      const key = normalize(category.description);
      exact.set(key, [...(exact.get(key) ?? []), category.path]);
    }
    const exactDuplicates = [...exact.entries()]
      .filter(([key, paths]) => key && paths.length > 1)
      .map(([description, paths]) => ({ description, paths }));

    const prepared = taxonomy.semanticCategories.map((category) => ({
      category,
      tokens: tokens(category.description),
    }));
    const nearPairs: Array<{
      score: number;
      sameParent: boolean;
      left: string;
      right: string;
      leftDescription: string;
      rightDescription: string;
    }> = [];
    for (let left = 0; left < prepared.length; left += 1) {
      for (let right = left + 1; right < prepared.length; right += 1) {
        const a = prepared[left];
        const b = prepared[right];
        const score = jaccard(a.tokens, b.tokens);
        if (score < 0.42) continue;
        nearPairs.push({
          score,
          sameParent: a.category.parentKey === b.category.parentKey,
          left: a.category.path,
          right: b.category.path,
          leftDescription: a.category.description,
          rightDescription: b.category.description,
        });
      }
    }
    nearPairs.sort((a, b) =>
      b.score - a.score || Number(b.sameParent) - Number(a.sameParent) || a.left.localeCompare(b.left));

    const tooShort = taxonomy.categories
      .filter((category) => category.description.trim().length < 24)
      .map((category) => `${category.path} :: ${category.description}`);
    const structuralRouteable = taxonomy.categories
      .filter((category) => parentKeys.has(category.key) && category.routeable)
      .map((category) => category.path);
    const badExpected = cases.flatMap((testCase) => {
      const expected = Array.isArray(testCase.expected) ? testCase.expected : [testCase.expected];
      return expected
        .filter((key) => !taxonomy.byKey.get(key)?.routeable)
        .map((key) => `${testCase.id}:${key}`);
    });

    console.log("=== REFINED TAXONOMY AUDIT ===");
    console.log(`sourceSha256=${sourceSha}`);
    console.log(`finalSha256=${finalSha}`);
    console.log(`replacements=${refinements.descriptionReplacements.length} addedCases=${refinements.additionalCases.length}`);
    console.log(`total=${taxonomy.categories.length} routeable=${taxonomy.routeableCategories.length} semantic=${taxonomy.semanticCategories.length} cases=${cases.length}`);
    console.log(`structuralRouteable=${structuralRouteable.length} exactDuplicates=${exactDuplicates.length} descriptionsUnder24=${tooShort.length} badExpected=${badExpected.length}`);
    console.log("=== REMAINING TOP LEXICAL NEAR PAIRS ===");
    for (const pair of nearPairs.slice(0, 80)) {
      console.log(`${pair.score.toFixed(3)}${pair.sameParent ? " sibling" : ""} ${pair.left} <-> ${pair.right}`);
      console.log(`  L: ${pair.leftDescription}`);
      console.log(`  R: ${pair.rightDescription}`);
    }
    console.log("=== ADDED ADVERSARIAL CASES ===");
    for (const testCase of refinements.additionalCases) {
      const expected = Array.isArray(testCase.expected) ? testCase.expected.join("|") : testCase.expected;
      console.log(`${testCase.id} | ${expected} | ${testCase.summary}`);
    }

    expect(taxonomy.categories).toHaveLength(275);
    expect(taxonomy.routeableCategories).toHaveLength(224);
    expect(taxonomy.semanticCategories).toHaveLength(223);
    expect(structuralRouteable).toEqual([]);
    expect(exactDuplicates).toEqual([]);
    expect(tooShort).toEqual([]);
    expect(badExpected).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(100);
  });
});
