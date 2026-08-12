import { describe, expect, it } from "vitest";

import { compileResourceTaxonomy } from "../dist/routing/resource-taxonomy.js";
import {
  auditCompiledTaxonomy,
  normalizeDescription,
  tokenJaccard,
} from "../tools/routing-taxonomy-audit.mjs";

function fixtureTaxonomy() {
  return compileResourceTaxonomy({
    schemaVersion: 1,
    fallback: "inbox",
    categories: {
      inbox: {
        segment: "_INBOX",
        description: "Неклассифицированные материалы для ручного разбора.",
      },
      docs: {
        segment: "docs",
        description: "Документация и справочные материалы по программным системам.",
        routeable: false,
        children: {
          "docs-code": {
            segment: "code",
            description: "Документация по исходному коду, API и устройству программных систем.",
          },
          "docs-api": {
            segment: "api",
            description: "Документация по API, исходному коду и устройству программных систем.",
          },
        },
      },
      projects: {
        segment: "projects",
        description: "Материалы конкретных программных проектов и их разработки.",
        routeable: false,
        children: {
          "projects-code": {
            segment: "code",
            description: "Документация по исходному коду, API и устройству программных систем.",
          },
        },
      },
    },
  });
}

describe("routing taxonomy audit", () => {
  it("normalizes descriptions and scores lexical overlap deterministically", () => {
    expect(normalizeDescription(" API,  Документация! ")).toBe("api документация");
    expect(tokenJaccard("код api документация", "документация api примеры")).toBeCloseTo(0.5);
  });

  it("reports duplicate descriptions, repeated segments and excludes fallback from semantic ranking", () => {
    const taxonomy = fixtureTaxonomy();
    const report = auditCompiledTaxonomy(taxonomy, { language: "ru", top: 20 });

    expect(report.counts).toEqual({ total: 6, routeable: 4, semantic: 3, structural: 2 });
    expect(report.fallback.appearsInSemanticRanking).toBe(false);
    expect(report.semanticNonLeaves).toEqual([]);
    expect(report.structuralRouteable).toEqual([]);
    expect(report.exactDuplicateDescriptions).toHaveLength(1);
    expect(report.exactDuplicateDescriptions[0].categories.map((entry) => entry.path).sort())
      .toEqual(["docs/code", "projects/code"]);
    expect(report.repeatedSegments.find((entry) => entry.segment === "code")?.categories)
      .toHaveLength(2);
    expect(report.languageProblems).toEqual([]);
    expect(report.lexicalNearPairs.some((pair) =>
      new Set([pair.left.path, pair.right.path]).has("docs/api"))).toBe(true);
  });

  it("reports nearest cached embedding pairs without making model calls", () => {
    const taxonomy = fixtureTaxonomy();
    const cache = {
      categories: taxonomy.semanticCategories.map((category) => ({
        key: category.key,
        embedding: category.key === "docs-code"
          ? [1, 0]
          : category.key === "docs-api"
            ? [0.999, 0.02]
            : [0, 1],
      })),
    };
    const report = auditCompiledTaxonomy(taxonomy, { language: "ru", top: 5, cache });
    expect(report.embeddingNearPairs[0].left.key).toBe("docs-code");
    expect(report.embeddingNearPairs[0].right.key).toBe("docs-api");
    expect(report.embeddingNearPairs[0].score).toBeGreaterThan(0.99);
  });
});
