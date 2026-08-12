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

describe("embedded Russian taxonomy payload audit", () => {
  it("decodes the exact generator payload and prints the complete semantic catalog", () => {
    const generator = readFileSync("tools/apply-russian-routing-taxonomy.py", "utf8");
    const expectedSha = extractString(generator, "TAXONOMY_SHA256");
    const payload = extractString(generator, "TAXONOMY_GZIP_B64").replace(/\\s+/g, "");
    const yaml = gunzipSync(Buffer.from(payload, "base64")).toString("utf8");
    const actualSha = createHash("sha256").update(yaml, "utf8").digest("hex");
    expect(actualSha).toBe(expectedSha);

    const taxonomy = parseResourceTaxonomyYaml(yaml, "embedded Russian resource taxonomy");
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

    const short = taxonomy.categories
      .filter((category) => normalize(category.description).length < 32)
      .map((category) => `${category.path} :: ${category.description}`);
    const structuralRouteable = taxonomy.categories
      .filter((category) => parentKeys.has(category.key) && category.routeable)
      .map((category) => category.path);

    console.log("=== EMBEDDED TAXONOMY AUDIT ===");
    console.log(`sha256=${actualSha}`);
    console.log(`total=${taxonomy.categories.length} routeable=${taxonomy.routeableCategories.length} semantic=${taxonomy.semanticCategories.length}`);
    console.log(`structuralRouteable=${structuralRouteable.length} exactDuplicates=${exactDuplicates.length} shortDescriptions=${short.length}`);
    console.log("=== ALL CATEGORIES path | key | routeable | description ===");
    for (const category of taxonomy.categories) {
      console.log(`${category.path} | ${category.key} | ${category.routeable ? "R" : "S"} | ${category.description}`);
    }
    console.log("=== EXACT DUPLICATE DESCRIPTIONS ===");
    for (const duplicate of exactDuplicates) {
      console.log(`${duplicate.paths.join(" <-> ")} :: ${duplicate.description}`);
    }
    console.log("=== SHORT DESCRIPTIONS ===");
    for (const entry of short) console.log(entry);
    console.log("=== TOP LEXICAL NEAR PAIRS ===");
    for (const pair of nearPairs.slice(0, 80)) {
      console.log(`${pair.score.toFixed(3)}${pair.sameParent ? " sibling" : ""} ${pair.left} <-> ${pair.right}`);
      console.log(`  L: ${pair.leftDescription}`);
      console.log(`  R: ${pair.rightDescription}`);
    }

    // This temporary audit intentionally pins only hard structural facts. Textual
    // ambiguity is reviewed from the emitted catalog before examples are committed.
    expect(taxonomy.categories).toHaveLength(275);
    expect(taxonomy.routeableCategories).toHaveLength(224);
    expect(taxonomy.semanticCategories).toHaveLength(223);
    expect(structuralRouteable).toEqual([]);
  });
});
