#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugin/openviking-import-tools.ts"
SKILL = ROOT / "skills/openviking-context-database/SKILL.md"
TEST = ROOT / "tests/add-resource-routing-tool.test.ts"
PROBE = ROOT / "tools/routing-probe.mjs"


def replace_once(text: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return updated


plugin = PLUGIN.read_text(encoding="utf-8")

plugin = replace_once(
    plugin,
    r'resourceRouting\?: Pick<ResourceRoutingService, "enabled" \| "resolveCategory" \| "routeAutomatic">;',
    'resourceRouting?: Pick<ResourceRoutingService, "enabled" | "resolveCategoryOrFallback" | "routeAutomatic">;',
    "resource routing dependency surface",
)

plugin = replace_once(
    plugin,
    r'          "When automatic resource routing is enabled and neither to, parent, nor category is supplied, you MUST provide summary in Russian:.*?" \+\n'
    r'          "Use category only for an existing semantic category key from the configured taxonomy; never invent category keys or resource URIs\. Explicit to/parent/category bypass automatic classification\. " \+\n',
    '          "When automatic resource routing is enabled and category is not supplied, you MUST provide summary in Russian: one short sentence describing what the resource is about and what it is useful for. Write the summary in Russian even when the source material is in another language; preserve product names, commands, code identifiers, protocols, and other technical terms when useful. Before writing that summary, inspect or read enough of the resource to understand its actual content unless the content is already established in the conversation; never guess from its filename or path. Describe semantic content and purpose. When provenance is part of the semantic resource type, state it naturally, for example веб-статья, email-переписка, расшифровка встречи или скриншот терминала. Do not copy raw filename, path, MIME type, or storage location into the summary. " +\n'
    '          "For an explicit destination, set category to an existing full taxonomy path such as code/source/javascript; a semantic key is also accepted for compatibility. Never invent a path. Unknown, ambiguous, or organizational-only category selectors are stored in the configured fallback category instead of creating new taxonomy folders. " +\n',
    "tool description",
    re.S,
)

plugin = replace_once(
    plugin,
    r'        parameters: Type\.Object\(\{\n.*?\n        \}\),\n        async execute',
    '''        parameters: Type.Object({
          source: Type.String({ description: "Local path, OpenClaw media attachment path, directory path, public URL, or Git URL" }),
          summary: Type.Optional(Type.String({ description: "Required for automatic routing: one short sentence in Russian based on known or inspected resource content, describing its semantic content and purpose. Write it in Russian even for foreign-language sources; technical names and identifiers may remain in their original form. State semantically important provenance naturally, but never guess from or copy raw filename/path/MIME/storage metadata." })),
          category: Type.Optional(Type.String({ description: "Optional explicit existing taxonomy destination. Prefer the full taxonomy path, for example code/source/javascript. A semantic key is also accepted for compatibility. Unknown, ambiguous, or organizational-only selectors fall back to the configured inbox instead of creating a new path." })),
        }),
        async execute''',
    "minimal parameter schema",
    re.S,
)

plugin = replace_once(
    plugin,
    r'          const explicitTo = .*?\n\n          const session = deps\.resolvePluginSessionRouting\(ctx\);\n          let targetTo = .*?\n          let routingDetails: Record<string, unknown> = \{\n            mode: .*?\n          \};',
    '''          const explicitCategory = typeof params.category === "string" && params.category.trim() ? params.category.trim() : undefined;

          const session = deps.resolvePluginSessionRouting(ctx);
          let targetParent: string | undefined;
          let createParent: boolean | undefined;
          let routingNotice: string | undefined;
          let routingDetails: Record<string, unknown> = {
            mode: deps.resourceRouting?.enabled ? "automatic" : "legacy_default",
          };''',
    "explicit destination removal",
    re.S,
)

plugin = replace_once(
    plugin,
    r'''          if \(explicitCategory\) \{\n            if \(!deps\.resourceRouting\?\.enabled\) \{.*?\n          \} else if \(!explicitTo && !explicitParent && deps\.resourceRouting\?\.enabled\) \{''',
    '''          if (explicitCategory) {
            if (!deps.resourceRouting?.enabled) {
              return rejectedResourceImport(
                "Semantic category routing is disabled. Enable resourceRouting before using an explicit category destination.",
                { category: explicitCategory },
              );
            }
            try {
              const resolved = deps.resourceRouting.resolveCategoryOrFallback(session.agentId, explicitCategory);
              targetParent = resolved.category.uri;
              createParent = true;
              routingDetails = {
                mode: "explicit_category",
                requestedCategory: resolved.requested,
                matchedBy: resolved.matchedBy,
                category: resolved.category.key,
                categoryPath: resolved.category.path,
                parent: resolved.category.uri,
                fallback: resolved.fallback,
                fallbackReason: resolved.fallbackReason,
              };
              if (resolved.fallback) {
                routingNotice =
                  `Requested category ${JSON.stringify(explicitCategory)} was not a valid routeable taxonomy destination ` +
                  `(${resolved.fallbackReason ?? "fallback"}); stored under fallback ${resolved.category.path}.`;
              }
            } catch (error) {
              return {
                content: [{
                  type: "text" as const,
                  text:
                    `OpenViking explicit category resolution failed; the resource was NOT imported. ${error instanceof Error ? error.message : String(error)}`,
                }],
                details: {
                  action: "routing_failed",
                  source,
                  requestedCategory: explicitCategory,
                  error: error instanceof Error ? error.message : String(error),
                },
              };
            }
          } else if (deps.resourceRouting?.enabled) {''',
    "explicit category fallback routing",
    re.S,
)

plugin = re.sub(r'\n\s+reason: typeof params\.reason === "string" \? params\.reason : undefined,', '', plugin)
plugin = re.sub(r'\n\s+instruction: typeof params\.instruction === "string" \? params\.instruction : undefined,', '', plugin)
plugin = re.sub(r'\n\s+strict: typeof params\.strict === "boolean" \? params\.strict : undefined,', '', plugin)
plugin = re.sub(r'\n\s+ignoreDirs: typeof params\.ignore_dirs === "string".*?: undefined,', '', plugin)
plugin = re.sub(r'\n\s+include: typeof params\.include === "string".*?: undefined,', '', plugin)
plugin = re.sub(r'\n\s+exclude: typeof params\.exclude === "string".*?: undefined,', '', plugin)
plugin = re.sub(r'\n\s+preserveStructure: typeof params\.preserve_structure === "boolean".*?: undefined,', '', plugin)
plugin = plugin.replace('              to: targetTo,\n', '')

plugin = replace_once(
    plugin,
    r'content: \[\{ type: "text" as const, text: formatResourceImportText\(result\) \}\],',
    'content: [{ type: "text" as const, text: `${formatResourceImportText(result)}${routingNotice ? ` ${routingNotice}` : ""}` }],',
    "routing fallback notice",
)

if re.search(r'params\.(?:to|parent|create_parent|reason|instruction|strict|ignore_dirs|include|exclude|preserve_structure)', plugin):
    raise SystemExit("plugin still references a removed agent parameter")
if "resolveCategory(session.agentId" in plugin:
    raise SystemExit("plugin still uses strict resolveCategory for agent explicit destinations")

PLUGIN.write_text(plugin, encoding="utf-8")

skill = SKILL.read_text(encoding="utf-8")
start = skill.index("### `add_resource`")
end = skill.index("### `add_skill`", start)
minimal_section = '''### `add_resource`

Import resources into `viking://resources/...`.

This agent tool is disabled by default. Use it only when the user explicitly asks to import, add, upload, save, or index a resource. Never use it during search/retrieval optimization.

The agent-facing contract is intentionally minimal and deterministic:

| Parameter | Required | Description |
|---|---|---|
| `source` | Yes | Local path, OpenClaw media attachment path, directory path, public URL, or Git URL. |
| `summary` | Automatic routing only | One short sentence **in Russian** based on known/inspected content: what the resource is about and what it is useful for. Preserve technical product names, commands, protocols and identifiers when useful. |
| `category` | No | Optional explicit existing taxonomy destination. Prefer the full path such as `code/source/javascript`; a semantic key is also accepted for compatibility. |

When `resourceRouting.enabled=true` and `category` is omitted, inspect/read enough of the resource to understand its actual content, then write `summary` in Russian even when the source itself is in another language. Do not infer content from filename/path alone and do not copy raw filename/path/MIME/storage metadata into the summary.

When the user explicitly names a destination path, copy that existing taxonomy path into `category`. The plugin validates it against the loaded taxonomy. It never treats `category` as an arbitrary URI: an unknown, ambiguous, or organizational-only selector is redirected to the configured fallback (normally `_INBOX`) and reported as a fallback instead of creating a new taxonomy path.

The agent tool deliberately does **not** expose arbitrary `to`/`parent` URIs, `create_parent`, `reason`, `instruction`, parser filters, strictness switches, structure switches, watch controls, tags, or low-level connector arguments. Those remain available only through lower-level/manual interfaces where a human can choose them deliberately.

Automatic routing selects only routeable taxonomy categories. Category embeddings and reranker documents include the full taxonomy path plus the category description. If cosine similarity is below the configured confidence threshold, the configured fallback category is used. Routing infrastructure failures still fail closed and the resource is not imported.

The agent tool always submits the import with `wait=false`. OpenViking continues parsing, semantic extraction and indexing asynchronously. If a mutating request loses its HTTP response, inspect OpenViking state before any deliberate retry; never repeat the same import automatically after an outcome-unknown result.

'''
skill = skill[:start] + minimal_section + skill[end:]
SKILL.write_text(skill, encoding="utf-8")

TEST.write_text(r'''import { describe, expect, it, vi } from "vitest";

import { registerOpenVikingImportTools } from "../plugin/openviking-import-tools.js";

type ToolFactory = (ctx: Record<string, unknown>) => {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

function makeCategory(key: string, path: string) {
  const uri = `viking://resources/${path}`;
  const segments = path.split("/");
  const description = `${key} category`;
  return {
    key,
    segment: segments.at(-1) ?? key,
    description,
    routeable: true,
    uri,
    path,
    routingText: `path: ${path}\ndescription: ${description}`,
    parentKey: null,
    depth: segments.length,
  };
}

function setup(options: { routingEnabled?: boolean; routeFailure?: Error } = {}) {
  const factories = new Map<string, ToolFactory>();
  const addResource = vi.fn(async () => ({
    status: "success",
    root_uri: "viking://resources/result",
    task_id: "task-resource-1",
  }));
  const getClient = vi.fn(async () => ({ addResource, removeResource: vi.fn(), addSkill: vi.fn() }));
  const resolveCategoryOrFallback = vi.fn((_agentId: string, selector: string) => {
    if (selector === "code/source/javascript") {
      return {
        requested: selector,
        category: makeCategory("code-source-javascript", "code/source/javascript"),
        matchedBy: "path" as const,
        fallback: false,
      };
    }
    if (selector === "code-source-javascript") {
      return {
        requested: selector,
        category: makeCategory("code-source-javascript", "code/source/javascript"),
        matchedBy: "key" as const,
        fallback: false,
      };
    }
    return {
      requested: selector,
      category: makeCategory("inbox", "__INBOX__"),
      matchedBy: "fallback" as const,
      fallback: true,
      fallbackReason: "unknown_category" as const,
    };
  });
  const routeAutomatic = options.routeFailure
    ? vi.fn(async () => { throw options.routeFailure; })
    : vi.fn(async () => ({
      category: makeCategory("docs-guides-howtos", "docs/guides/howtos"),
      semanticInput: "Практическое руководство по настройке OpenClaw.",
      decision: {
        categoryKey: "docs-guides-howtos",
        uri: "viking://resources/docs/guides/howtos",
        fallback: false,
        embeddingCandidates: [
          { key: "docs-guides-howtos", description: "path: docs/guides/howtos\ndescription: Практические инструкции", score: 0.82 },
          { key: "docs-guides-tutorials", description: "path: docs/guides/tutorials\ndescription: Учебные руководства", score: 0.79 },
        ],
        rerankerUsed: true,
        rerankerScores: [
          { key: "docs-guides-howtos", score: 0.91 },
          { key: "docs-guides-tutorials", score: 0.72 },
        ],
        timing: { embeddingMs: 82, rerankerMs: 374, totalMs: 460 },
      },
    }));

  registerOpenVikingImportTools({
    registerTool: (factory, meta) => factories.set(meta.name, factory as ToolFactory),
    getClient,
    resolvePluginSessionRouting: () => ({ agentId: "main", actorPeerId: "main_peer" }),
    isBypassedSession: () => false,
    makeBypassedToolResult: vi.fn(),
    enableAddResourceTool: true,
    enableRemoveResourceTool: false,
    resourceRouting: {
      enabled: options.routingEnabled ?? true,
      resolveCategoryOrFallback,
      routeAutomatic,
    },
  });

  return { factories, addResource, getClient, resolveCategoryOrFallback, routeAutomatic };
}

describe("add_resource routing tool", () => {
  it("publishes only source, summary and explicit taxonomy category", () => {
    const tool = setup().factories.get("add_resource")!({});
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(["source", "summary", "category"]);
  });

  it("requires summary for automatic routing before touching models or OpenViking", async () => {
    const { factories, routeAutomatic, getClient } = setup();
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/guide.md",
    }) as { details?: { action?: string } };
    expect(result.details?.action).toBe("rejected");
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it("rejects an English-only automatic summary before routing", async () => {
    const { factories, routeAutomatic, getClient } = setup();
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/guide.md",
      summary: "A practical setup guide for configuring OpenClaw.",
    }) as { details?: { action?: string }; content?: Array<{ text?: string }> };
    expect(result.details?.action).toBe("rejected");
    expect(result.content?.[0]?.text).toMatch(/Russian|рус/i);
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it("routes a Russian summary automatically and forwards only a trusted parent", async () => {
    const { factories, routeAutomatic, addResource } = setup();
    await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/draft/guide.md",
      summary: "Практическое руководство по настройке OpenClaw и его основных параметров.",
    });
    expect(routeAutomatic).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "main",
      source: "/workspace/draft/guide.md",
      summary: "Практическое руководство по настройке OpenClaw и его основных параметров.",
    }));
    expect(addResource).toHaveBeenCalledWith({
      pathOrUrl: "/workspace/draft/guide.md",
      parent: "viking://resources/docs/guides/howtos",
      createParent: true,
      wait: false,
    }, "main_peer");
  });

  it("accepts an explicit full taxonomy path without invoking automatic models", async () => {
    const { factories, resolveCategoryOrFallback, routeAutomatic, addResource } = setup();
    await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/main.js",
      category: "code/source/javascript",
    });
    expect(resolveCategoryOrFallback).toHaveBeenCalledWith("main", "code/source/javascript");
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(addResource).toHaveBeenCalledWith({
      pathOrUrl: "/workspace/main.js",
      parent: "viking://resources/code/source/javascript",
      createParent: true,
      wait: false,
    }, "main_peer");
  });

  it("keeps semantic-key compatibility for explicit category destinations", async () => {
    const { factories, resolveCategoryOrFallback, addResource } = setup();
    await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/main.js",
      category: "code-source-javascript",
    });
    expect(resolveCategoryOrFallback).toHaveBeenCalledWith("main", "code-source-javascript");
    expect(addResource).toHaveBeenCalledWith(expect.objectContaining({
      parent: "viking://resources/code/source/javascript",
    }), "main_peer");
  });

  it("imports into inbox instead of inventing an unknown explicit category", async () => {
    const { factories, routeAutomatic, addResource } = setup();
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/mystery.md",
      category: "code/source/does-not-exist",
    }) as { details?: Record<string, any>; content?: Array<{ text?: string }> };
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(addResource).toHaveBeenCalledWith({
      pathOrUrl: "/workspace/mystery.md",
      parent: "viking://resources/__INBOX__",
      createParent: true,
      wait: false,
    }, "main_peer");
    expect(result.details?.routing).toMatchObject({
      mode: "explicit_category",
      requestedCategory: "code/source/does-not-exist",
      category: "inbox",
      categoryPath: "__INBOX__",
      fallback: true,
      fallbackReason: "unknown_category",
    });
    expect(result.content?.[0]?.text).toContain("stored under fallback __INBOX__");
  });

  it("does not import when automatic-routing infrastructure fails", async () => {
    const { factories, getClient } = setup({ routeFailure: new Error("embedder HTTP 503") });
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/guide.md",
      summary: "Практическое руководство по настройке программного сервиса.",
    }) as { details?: { action?: string } };
    expect(result.details?.action).toBe("routing_failed");
    expect(getClient).not.toHaveBeenCalled();
  });

  it("keeps legacy source-only import when resource routing is disabled", async () => {
    const { factories, routeAutomatic, addResource } = setup({ routingEnabled: false });
    await factories.get("add_resource")!({}).execute("call", { source: "/workspace/legacy.md" });
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(addResource).toHaveBeenCalledWith({
      pathOrUrl: "/workspace/legacy.md",
      parent: undefined,
      createParent: undefined,
      wait: false,
    }, "main_peer");
  });
});
''', encoding="utf-8")

probe = PROBE.read_text(encoding="utf-8")
probe = replace_once(
    probe,
    r'description: category\.description,',
    'description: category.routingText,',
    "probe production routing text",
)
probe = replace_once(
    probe,
    r'      actual: decision\.categoryKey,',
    '      actual: decision.categoryKey,\n      actualPath: taxonomy.byKey.get(decision.categoryKey)?.path,',
    "probe selected path",
)
probe = replace_once(
    probe,
    r'        key: candidate\.key,\n        score: round\(candidate\.score\),',
    '        key: candidate.key,\n        path: taxonomy.byKey.get(candidate.key)?.path,\n        score: round(candidate.score),',
    "probe cosine paths",
)
probe = replace_once(
    probe,
    r'        key: entry\.key,\n        score: round\(entry\.score\),',
    '        key: entry.key,\n        path: taxonomy.byKey.get(entry.key)?.path,\n        score: round(entry.score),',
    "probe reranker paths",
)
probe = probe.replace(
    '`${mark} ${row.id}: expected=${expected} actual=${row.actual} ` +',
    '`${mark} ${row.id}: expected=${expected} actual=${row.actualPath ?? row.actual} ` +',
    1,
)
probe = probe.replace(
    '`${entry.key}=${entry.score}`',
    '`${entry.path ?? entry.key}=${entry.score}`',
)
PROBE.write_text(probe, encoding="utf-8")

print("Applied final deterministic agent contract:")
print("  source + Russian summary + explicit taxonomy path/key")
print("  unknown/ambiguous/organizational explicit category -> fallback inbox")
print("  arbitrary agent to/parent/create_parent and extraction controls removed")
print("  routing probe now uses production path+description routing text")
