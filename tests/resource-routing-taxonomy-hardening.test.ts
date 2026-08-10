import { describe, expect, it } from "vitest";

import {
  parseResourceTaxonomy,
  parseResourceTaxonomyYaml,
  RESOURCE_TAXONOMY_MAX_URI_CHARS,
} from "../resource-routing/taxonomy.js";

function deepTaxonomy(depth: number): unknown {
  let node: Record<string, unknown> = {
    segment: `leaf-${depth}`,
    description: `Leaf at depth ${depth}`,
  };
  for (let index = depth - 1; index >= 0; index -= 1) {
    node = {
      segment: "x",
      description: `Depth ${index}`,
      children: {
        [`k${index + 1}`]: node,
      },
    };
  }
  return {
    schemaVersion: 1,
    categories: {
      k0: node,
    },
  };
}

describe("resource taxonomy parser hardening", () => {
  it("handles a very deep valid tree without depending on the JS call stack", () => {
    const taxonomy = parseResourceTaxonomy(deepTaxonomy(1_500));
    const leaf = taxonomy.byKey.get("k1500");
    expect(leaf?.depth).toBe(1_500);
    expect(leaf?.uri.startsWith("viking://resources/")).toBe(true);
    expect(taxonomy.categories).toHaveLength(1_501);
  });

  it("rejects a compiled URI that exceeds the plugin safety cap", () => {
    expect(() => parseResourceTaxonomy(deepTaxonomy(2_100))).toThrow(
      new RegExp(`longer than ${RESOURCE_TAXONOMY_MAX_URI_CHARS} characters`),
    );
  });

  it("rejects YAML aliases instead of allowing shared or recursive taxonomy nodes", () => {
    const yaml = `
schemaVersion: 1
categories:
  first: &shared
    segment: first
    description: First category
  second: *shared
`;
    expect(() => parseResourceTaxonomyYaml(yaml)).toThrow(/YAML parse failed/i);
  });

  it("rejects hidden dot-prefixed resource segments", () => {
    expect(() => parseResourceTaxonomy({
      schemaVersion: 1,
      categories: {
        hidden: {
          segment: ".hidden",
          description: "Should never become a hidden VikingFS category.",
        },
      },
    })).toThrow(/not a safe resource URI segment/);
  });

  it("rejects reusing the same node object in multiple branches", () => {
    const shared = {
      segment: "shared",
      description: "Shared object",
    };
    expect(() => parseResourceTaxonomy({
      schemaVersion: 1,
      categories: {
        first: shared,
        second: shared,
      },
    })).toThrow(/reuses a node object or contains a cycle/);
  });

  it("rejects descriptions that are unreasonably large for semantic routing", () => {
    expect(() => parseResourceTaxonomy({
      schemaVersion: 1,
      categories: {
        huge: {
          segment: "huge",
          description: "x".repeat(4_001),
        },
      },
    })).toThrow(/description must be at most 4000 characters/);
  });
});
