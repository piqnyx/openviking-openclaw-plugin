#!/usr/bin/env python3
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def regex_once(path: Path, pattern: str, replacement: str, label: str, flags: int = 0) -> None:
    text = path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one regex match, got {count}")
    path.write_text(updated, encoding="utf-8")


taxonomy = ROOT / "routing/resource-taxonomy.ts"
replace_once(
    taxonomy,
    'const CATEGORY_KEYS = ["segment", "description", "routeable", "children"] as const;',
    'const CATEGORY_KEYS = ["segment", "description", "distinguishFrom", "routeable", "children"] as const;',
    "taxonomy allowed category keys",
)
replace_once(
    taxonomy,
    '''export type ResourceTaxonomyCategoryNode = {
  segment: string;
  description: string;
  routeable?: boolean;
''',
    '''export type ResourceTaxonomyCategoryNode = {
  segment: string;
  description: string;
  distinguishFrom?: string[];
  routeable?: boolean;
''',
    "taxonomy source node distinguishFrom",
)
replace_once(
    taxonomy,
    '''  description: string;
  routeable: boolean;
  uri: string;
  path: string;
  routingText: string;
''',
    '''  description: string;
  distinguishFrom: readonly string[];
  routeable: boolean;
  uri: string;
  path: string;
  embeddingText: string;
  rerankText: string;
''',
    "compiled taxonomy semantic texts",
)
replace_once(
    taxonomy,
    '''type RoutingAncestor = {
  path: string;
  description: string;
};
''',
    '''type RoutingAncestor = {
  path: string;
  description: string;
  distinguishFrom: readonly string[];
};
''',
    "routing ancestor hints",
)
replace_once(
    taxonomy,
    '''function parseSemanticKey(value: string, label: string): string {
''',
    '''function parseOptionalStringList(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  if (value.length > 32) {
    throw new Error(`${label} must contain at most 32 entries`);
  }
  return value.map((entry, index) => parseNonEmptyString(entry, `${label}[${index}]`, 1_000));
}

function parseSemanticKey(value: string, label: string): string {
''',
    "taxonomy string list parser",
)
regex_once(
    taxonomy,
    r'''function renderCategoryRoutingText\([\s\S]*?\n}\n\nfunction canonicalRoutingData''',
    '''function renderCategoryEmbeddingText(
  path: string,
  description: string,
  ancestors: readonly RoutingAncestor[],
): string {
  const lines = [`description: ${description}`];
  if (ancestors.length > 0) {
    lines.push(
      `ancestors: ${ancestors.map((ancestor) => `${ancestor.path}: ${ancestor.description}`).join(" > ")}`,
    );
  }
  lines.push(`path: ${path}`);
  return lines.join("\\n");
}

function renderCategoryRerankText(
  embeddingText: string,
  distinguishFrom: readonly string[],
  ancestors: readonly RoutingAncestor[],
): string {
  const inherited = ancestors.flatMap((ancestor) =>
    ancestor.distinguishFrom.map((hint) => `${ancestor.path}: ${hint}`),
  );
  const hints = [...inherited, ...distinguishFrom];
  if (hints.length === 0) {
    return embeddingText;
  }
  return `${embeddingText}\\ndistinguishFrom: ${hints.join(" | ")}`;
}

function canonicalRoutingData''',
    "split category embedding and rerank renderers",
)
replace_once(
    taxonomy,
    '''    .map(({ key, segment, description, routeable, uri, path, routingText, parentKey, depth }) => ({
      key,
      segment,
      description,
      routeable,
      uri,
      path,
      routingText,
      parentKey,
      depth,
    }));
''',
    '''    .map(({ key, segment, description, distinguishFrom, routeable, uri, path, embeddingText, rerankText, parentKey, depth }) => ({
      key,
      segment,
      description,
      distinguishFrom,
      routeable,
      uri,
      path,
      embeddingText,
      rerankText,
      parentKey,
      depth,
    }));
''',
    "canonical routing data semantic fields",
)
replace_once(
    taxonomy,
    '''    const description = parseNonEmptyString(
      current.raw.description,
      `resource taxonomy category ${JSON.stringify(key)} description`,
      MAX_DESCRIPTION_CHARS,
    );
    if (current.raw.routeable !== undefined && typeof current.raw.routeable !== "boolean") {
''',
    '''    const description = parseNonEmptyString(
      current.raw.description,
      `resource taxonomy category ${JSON.stringify(key)} description`,
      MAX_DESCRIPTION_CHARS,
    );
    const distinguishFrom = parseOptionalStringList(
      current.raw.distinguishFrom,
      `resource taxonomy category ${JSON.stringify(key)} distinguishFrom`,
    );
    if (current.raw.routeable !== undefined && typeof current.raw.routeable !== "boolean") {
''',
    "parse distinguishFrom",
)
replace_once(
    taxonomy,
    '''    const path = categoryPathFromUri(uri);
    const routingText = renderCategoryRoutingText(path, description, current.ancestors);

    const compiled: CompiledResourceCategory = {
      key,
      segment,
      description,
      routeable,
      uri,
      path,
      routingText,
''',
    '''    const path = categoryPathFromUri(uri);
    const embeddingText = renderCategoryEmbeddingText(path, description, current.ancestors);
    const rerankText = renderCategoryRerankText(embeddingText, distinguishFrom, current.ancestors);

    const compiled: CompiledResourceCategory = {
      key,
      segment,
      description,
      distinguishFrom,
      routeable,
      uri,
      path,
      embeddingText,
      rerankText,
''',
    "compile separated semantic texts",
)
replace_once(
    taxonomy,
    '''        { path, description },
''',
    '''        { path, description, distinguishFrom },
''',
    "inherit ancestor routing hints",
)

retrieval = ROOT / "routing/resource-routing-retrieval.ts"
replace_once(
    retrieval,
    '''export type ResourceRoutingEmbeddedCategory = {
  key: string;
  path: string;
  routingText: string;
  embedding: readonly number[];
};

export type ResourceRoutingCandidate = {
  key: string;
  path: string;
  routingText: string;
  score: number;
};
''',
    '''export type ResourceRoutingEmbeddedCategory = {
  key: string;
  path: string;
  embeddingText: string;
  rerankText?: string;
  embedding: readonly number[];
};

export type ResourceRoutingCandidate = {
  key: string;
  path: string;
  embeddingText: string;
  rerankText: string;
  score: number;
};
''',
    "retrieval semantic text types",
)
replace_once(
    retrieval,
    '''    if (typeof category.routingText !== "string" || !category.routingText.trim()) {
      throw new Error(`resource routing category ${JSON.stringify(category.key)} routingText must be non-empty`);
    }
    return {
      key: category.key,
      path: category.path,
      routingText: category.routingText,
      score: cosineSimilarity(queryEmbedding, category.embedding),
    };
''',
    '''    if (typeof category.embeddingText !== "string" || !category.embeddingText.trim()) {
      throw new Error(`resource routing category ${JSON.stringify(category.key)} embeddingText must be non-empty`);
    }
    if (category.rerankText !== undefined && (typeof category.rerankText !== "string" || !category.rerankText.trim())) {
      throw new Error(`resource routing category ${JSON.stringify(category.key)} rerankText must be non-empty when provided`);
    }
    return {
      key: category.key,
      path: category.path,
      embeddingText: category.embeddingText,
      rerankText: category.rerankText ?? category.embeddingText,
      score: cosineSimilarity(queryEmbedding, category.embedding),
    };
''',
    "retrieval semantic text validation",
)

router = ROOT / "routing/resource-router.ts"
replace_once(
    router,
    '''      routingText: category.routingText,
      embedding,
''',
    '''      embeddingText: category.embeddingText,
      rerankText: category.rerankText,
      embedding,
''',
    "router cached semantic texts",
)
replace_once(
    router,
    '''    const [embedding] = await input.embedder.embed([category.routingText]);
''',
    '''    const [embedding] = await input.embedder.embed([category.embeddingText]);
''',
    "category embedding uses positive embeddingText",
)
replace_once(
    router,
    '''      rerankCandidates.map((candidate) => candidate.routingText),
''',
    '''      rerankCandidates.map((candidate) => candidate.rerankText),
''',
    "reranker uses boundary-aware rerankText",
)

probe = ROOT / "tools/routing-probe.mjs"
replace_once(
    probe,
    '''        routingText: category.routingText,
        embedding,
''',
    '''        embeddingText: category.embeddingText,
        rerankText: category.rerankText,
        embedding,
''',
    "probe uses production semantic texts",
)

# Most test fixtures used the old single semantic text as a generic candidate
# document. Rename those fixtures to embeddingText; rerankText is optional at the
# retrieval boundary and defaults to embeddingText unless a compiled taxonomy
# supplies explicit boundary guidance.
for path in sorted((ROOT / "tests").glob("*")):
    if path.suffix not in {".ts", ".mjs"}:
        continue
    text = path.read_text(encoding="utf-8")
    if "routingText" in text:
        path.write_text(text.replace("routingText", "embeddingText"), encoding="utf-8")

# Add an explicit semantic-contract regression test to the core taxonomy suite.
test_path = ROOT / "tests/resource-taxonomy.test.ts"
test_text = test_path.read_text(encoding="utf-8")
marker = "\n});\n"
insert_at = test_text.rfind(marker)
if insert_at < 0:
    raise SystemExit("resource-taxonomy test: could not find suite terminator")
new_test = r'''

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
'''
test_path.write_text(test_text[:insert_at] + new_test + test_text[insert_at:], encoding="utf-8")

print("Applied routing semantic-text separation:")
print("  description/ancestry/path -> embeddingText")
print("  embeddingText + distinguishFrom boundaries -> rerankText")
print("  cache embeddings use embeddingText; conditional reranker uses rerankText")
print("Review git diff, then run typecheck and tests. Do not run this script twice.")
