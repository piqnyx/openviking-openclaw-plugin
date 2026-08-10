import { describe, expect, it } from "vitest";

import {
  parseResourceTaxonomy,
  parseResourceTaxonomyYaml,
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
    const taxonomy = parseResourceTaxonomy(deepTaxonomy(5_000));
    const leaf = taxonomy.byKey.get("k5000");
    expect(leaf?.depth).toBe(5_000);
    expect(leaf?.uri.startsWith("viking://resources/")).toBe(true);
    expect(taxonomy.categories).toHaveLength(5_001);
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

  it("rejects leading or trailing whitespace instead of silently rewriting a segment", () => {
    expect(() => parseResourceTaxonomy({
      schemaVersion: 1,
      categories: {
        docs: {
          segment: " docs ",
          description: "Documentation.",
        },
      },
    })).toThrow(/leading or trailing whitespace/);
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
