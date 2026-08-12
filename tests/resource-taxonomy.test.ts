import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  compileResourceTaxonomy,
  parseResourceTaxonomyYaml,
  resolvePerAgentFileTemplate,
} from "../routing/resource-taxonomy.js";

function category(segment: string, description = `${segment} resources`, children?: Record<string, unknown>) {
  return {
    segment,
    description,
    ...(children ? { children } : {}),
  };
}

describe("resource taxonomy", () => {
  it("compiles arbitrary nested categories into trusted viking URIs and full paths", () => {
    const compiled = compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: {
        inbox: category("__INBOX__"),
        projects: category("projects", "Project material", {
          openclaw: category("openclaw", "OpenClaw material", {
            openviking: category("openviking", "OpenViking integration material"),
          }),
        }),
      },
    });

    expect(compiled.fallbackUri).toBe("viking://resources/__INBOX__");
    expect(compiled.byKey.get("projects")?.uri).toBe("viking://resources/projects");
    expect(compiled.byKey.get("openclaw")?.uri).toBe("viking://resources/projects/openclaw");
    expect(compiled.byKey.get("openviking")?.uri).toBe(
      "viking://resources/projects/openclaw/openviking",
    );
    expect(compiled.byPath.get("projects/openclaw/openviking")?.key).toBe("openviking");
  });

  it("builds routing text from leaf meaning, semantic ancestors, and exact path", () => {
    const compiled = compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: {
        inbox: category("_INBOX", "Неклассифицированные материалы."),
        docs: {
          segment: "docs",
          description: "Документация и справочные материалы.",
          routeable: false,
          children: {
            "docs-code": {
              segment: "code",
              description: "Документация о программном коде и API.",
            },
          },
        },
        projects: {
          segment: "projects",
          description: "Материалы по программным проектам.",
          routeable: false,
          children: {
            "projects-code": {
              segment: "code",
              description: "Исходный код, относящийся к конкретным проектам.",
            },
          },
        },
      },
    });

    const docsCode = compiled.byPath.get("docs/code")!;
    const projectCode = compiled.byPath.get("projects/code")!;
    expect(docsCode.key).toBe("docs-code");
    expect(projectCode.key).toBe("projects-code");
    expect(docsCode.segment).toBe("code");
    expect(projectCode.segment).toBe("code");
    expect(docsCode.embeddingText).toContain("description: Документация о программном коде и API.");
    expect(docsCode.embeddingText).toContain("ancestors: docs: Документация и справочные материалы.");
    expect(docsCode.embeddingText).toContain("path: docs/code");
    expect(projectCode.embeddingText).toContain("ancestors: projects: Материалы по программным проектам.");
    expect(projectCode.embeddingText).toContain("path: projects/code");
    expect(docsCode.embeddingText).not.toBe(projectCode.embeddingText);
  });

  it("keeps fallback routeable for storage but excludes it from semantic ranking", () => {
    const compiled = compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: {
        inbox: category("__INBOX__"),
        docs: category("docs", "Documentation"),
      },
    });

    expect(compiled.routeableCategories.map((entry) => entry.key)).toEqual(["inbox", "docs"]);
    expect(compiled.semanticCategories.map((entry) => entry.key)).toEqual(["docs"]);
  });

  it("allows organizational nodes to be non-routeable while keeping their children routeable", () => {
    const compiled = compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: {
        inbox: category("__INBOX__"),
        media: {
          segment: "media",
          description: "Media grouping only",
          routeable: false,
          children: {
            screenshots: category("screenshots", "Application and terminal screenshots"),
          },
        },
      },
    });

    expect(compiled.byKey.get("media")?.routeable).toBe(false);
    expect(compiled.routeableCategories.map((entry) => entry.key)).toEqual([
      "inbox",
      "screenshots",
    ]);
    expect(compiled.semanticCategories.map((entry) => entry.key)).toEqual(["screenshots"]);
    expect(compiled.byKey.get("screenshots")?.uri).toBe(
      "viking://resources/media/screenshots",
    );
  });

  it("requires at least one semantic category besides fallback", () => {
    expect(() => compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: {
        inbox: category("__INBOX__", "Fallback only"),
      },
    })).toThrow(/semantic category besides the fallback/i);
  });

  it("does not impose a shallow taxonomy depth limit", () => {
    let current: Record<string, unknown> = category("leaf", "Deep leaf");
    for (let depth = 64; depth >= 1; depth -= 1) {
      current = category(`level-${depth}`, `Depth ${depth}`, {
        [`key-${depth + 1}`]: current,
      });
    }

    const compiled = compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: {
        inbox: category("__INBOX__"),
        "key-1": current,
      },
    });

    expect(compiled.categories.length).toBe(66);
    expect(Math.max(...compiled.categories.map((entry) => entry.depth))).toBe(65);
  });

  it("rejects duplicate semantic keys anywhere in the tree", () => {
    expect(() => compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: {
        inbox: category("__INBOX__"),
        left: category("left", "Left", {
          duplicate: category("a", "A"),
        }),
        right: category("right", "Right", {
          duplicate: category("b", "B"),
        }),
      },
    })).toThrow(/semantic key .*duplicate.*duplicated/i);
  });

  it("rejects different keys that resolve to the same URI", () => {
    expect(() => compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: {
        inbox: category("__INBOX__"),
        one: category("same", "One"),
        two: category("same", "Two"),
      },
    })).toThrow(/same URI/i);
  });

  it.each(["../escape", "a/b", "a\\b", "a?b", "a#b", "with space"])(
    "rejects unsafe URI segment %s",
    (segment) => {
      expect(() => compileResourceTaxonomy({
        schemaVersion: 1,
        fallback: "inbox",
        categories: {
          inbox: category("__INBOX__"),
          unsafe: category(segment, "Unsafe"),
        },
      })).toThrow(/safe URI segment/i);
    },
  );

  it("requires fallback to exist and be routeable", () => {
    expect(() => compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "missing",
      categories: {
        inbox: category("__INBOX__"),
      },
    })).toThrow(/does not reference an existing category/i);

    expect(() => compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: {
        inbox: {
          ...category("__INBOX__"),
          routeable: false,
        },
        docs: category("docs"),
      },
    })).toThrow(/fallback .* must reference a routeable category/i);
  });

  it("rejects unknown taxonomy and category fields", () => {
    expect(() => compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: { inbox: category("__INBOX__") },
      surprise: true,
    })).toThrow(/unknown keys: surprise/i);

    expect(() => compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: {
        inbox: {
          ...category("__INBOX__"),
          uri: "viking://resources/evil",
        },
      },
    })).toThrow(/unknown keys: uri/i);
  });

  it("rejects duplicate YAML mapping keys instead of silently accepting the last one", () => {
    expect(() => parseResourceTaxonomyYaml(`
      schemaVersion: 1
      fallback: inbox
      categories:
        inbox:
          segment: __INBOX__
          description: fallback
        inbox:
          segment: other
          description: duplicate
    `)).toThrow(/invalid YAML/i);
  });

  it("produces the same taxonomy hash when object key ordering changes", () => {
    const first = compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: {
        inbox: category("__INBOX__"),
        docs: category("docs", "Documentation"),
      },
    });
    const second = compileResourceTaxonomy({
      categories: {
        docs: { description: "Documentation", segment: "docs" },
        inbox: { description: "__INBOX__ resources", segment: "__INBOX__" },
      },
      fallback: "inbox",
      schemaVersion: 1,
    });

    expect(second.taxonomyHash).toBe(first.taxonomyHash);
  });

  it("loads the packaged default taxonomy and exposes a visible root inbox", () => {
    const text = readFileSync(
      new URL("../routing/default-resource-taxonomy.yaml", import.meta.url),
      "utf8",
    );
    const compiled = parseResourceTaxonomyYaml(text, "default taxonomy");

    expect(compiled.fallbackKey).toBe("inbox");
    expect(compiled.fallbackUri).toBe("viking://resources/__INBOX__");
    expect(compiled.routeableCategories.length).toBeGreaterThan(40);
    expect(compiled.semanticCategories.length).toBe(compiled.routeableCategories.length - 1);
    expect(compiled.semanticCategories.some((entry) => entry.key === compiled.fallbackKey)).toBe(false);
    expect(compiled.byKey.get("media-images-screenshots")?.uri).toBe(
      "viking://resources/media/images/screenshots",
    );
    expect(compiled.byKey.get("security-audits")?.uri).toBe(
      "viking://resources/security/audits",
    );
  });
});

describe("per-agent resource routing paths", () => {
  it("resolves one taxonomy file per agent", () => {
    expect(resolvePerAgentFileTemplate("~/.openclaw/{agentId}.yaml", "main")).toMatch(
      /\/\.openclaw\/main\.yaml$/,
    );
    expect(resolvePerAgentFileTemplate("~/.openclaw/{agentId}.yaml", "igor")).toMatch(
      /\/\.openclaw\/igor\.yaml$/,
    );
  });

  it.each(["../main", "main/evil", "main\\evil", "bad agent", ""])(
    "rejects unsafe agent id %j",
    (agentId) => {
      expect(() => resolvePerAgentFileTemplate("~/.openclaw/{agentId}.yaml", agentId)).toThrow();
    },
  );

  it("requires an explicit agent placeholder and an absolute resolved path", () => {
    expect(() => resolvePerAgentFileTemplate("~/.openclaw/main.yaml", "main")).toThrow(
      /must contain \{agentId\}/,
    );
    expect(() => resolvePerAgentFileTemplate("relative/{agentId}.yaml", "main")).toThrow(
      /absolute path/,
    );
  });

  it("keeps embedding text positive while boundary hints are reranker-only", () => {
    const taxonomy = compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: {
        inbox: {
          segment: "_INBOX",
          description: "Uncertain resources",
        },
        docs: {
          segment: "docs",
          description: "Documentation",
          distinguishFrom: ["Source code belongs under code"],
          routeable: false,
          children: {
            guide: {
              segment: "guide",
              description: "Practical guide",
              distinguishFrom: ["API reference belongs elsewhere"],
            },
          },
        },
      },
    });

    const guide = taxonomy.byKey.get("guide")!;
    expect(guide.embeddingText).toContain("description: Practical guide");
    expect(guide.embeddingText).toContain("docs: Documentation");
    expect(guide.embeddingText).not.toContain("Source code belongs under code");
    expect(guide.embeddingText).not.toContain("API reference belongs elsewhere");
    expect(guide.rerankText).toContain("Source code belongs under code");
    expect(guide.rerankText).toContain("API reference belongs elsewhere");
    expect(guide.distinguishFrom).toEqual(["API reference belongs elsewhere"]);
  });

});
