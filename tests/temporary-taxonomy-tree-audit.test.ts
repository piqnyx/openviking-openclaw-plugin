import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { parseResourceTaxonomyYaml } from "../routing/resource-taxonomy.js";

function extractString(source: string, name: string): string {
  const triple = new RegExp(`${name}\\s*=\\s*\"\"\"([\\s\\S]*?)\"\"\"`).exec(source)?.[1];
  if (triple !== undefined) return triple.trim();
  const single = new RegExp(`${name}\\s*=\\s*\"([^\"]+)\"`).exec(source)?.[1];
  if (single !== undefined) return single;
  throw new Error(`Could not extract ${name}`);
}

type Refinements = {
  descriptionReplacements: Array<{ old: string; new: string }>;
};

describe("temporary taxonomy tree architecture audit", () => {
  it("prints every refined taxonomy node", () => {
    const generator = readFileSync("tools/apply-russian-routing-taxonomy.py", "utf8");
    const payload = extractString(generator, "TAXONOMY_GZIP_B64").replace(/\\s+/g, "");
    let yaml = gunzipSync(Buffer.from(payload, "base64")).toString("utf8");
    const refinements = JSON.parse(
      readFileSync("tools/russian-taxonomy-refinements.json", "utf8"),
    ) as Refinements;
    for (const replacement of refinements.descriptionReplacements) {
      yaml = yaml.replace(replacement.old, replacement.new);
    }

    const taxonomy = parseResourceTaxonomyYaml(yaml, "temporary architecture audit");
    const parentKeys = new Set(
      taxonomy.categories.map((category) => category.parentKey).filter(Boolean),
    );

    console.log("=== FULL REFINED TAXONOMY TREE ===");
    for (const category of taxonomy.categories) {
      const depth = category.path.split("/").length;
      const kind = parentKeys.has(category.key) ? "STRUCT" : "LEAF";
      const routing = category.routeable ? "R" : "-";
      const semantic = taxonomy.semanticCategories.some((entry) => entry.key === category.key) ? "S" : "-";
      console.log(`${depth}\t${kind}\t${routing}${semantic}\t${category.path}\t${category.key}\t${category.description}`);
    }
    console.log("=== END FULL REFINED TAXONOMY TREE ===");

    expect(taxonomy.categories).toHaveLength(275);
  });
});
