#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugin/openviking-import-tools.ts"
SKILL = ROOT / "skills/openviking-context-database/SKILL.md"
TEST = ROOT / "tests/add-resource-routing-tool.test.ts"


def replace_once(text: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return updated


plugin = PLUGIN.read_text(encoding="utf-8")

plugin = replace_once(
    plugin,
    r'          "When automatic resource routing is enabled and neither to, parent, nor category is supplied, you MUST provide summary in Russian:.*?" \+\n'
    r'          "Use category only for an existing semantic category key from the configured taxonomy; never invent category keys or resource URIs\. Explicit to/parent/category bypass automatic classification\. " \+\n',
    '          "When automatic resource routing is enabled and category is not supplied, you MUST provide summary in Russian: one short sentence describing what the resource is about and what it is useful for. Write the summary in Russian even when the source material is in another language; preserve product names, commands, code identifiers, protocols, and other technical terms when useful. Before writing that summary, inspect or read enough of the resource to understand its actual content unless the content is already established in the conversation; never guess from its filename or path. Describe semantic content and purpose. When provenance is part of the semantic resource type, state it naturally, for example веб-статья, email-переписка, расшифровка встречи или скриншот терминала. Do not copy raw filename, path, MIME type, or storage location into the summary. " +\n'
    '          "Use category only as an explicit override with an existing semantic category key from the configured taxonomy; never invent category keys or resource URIs. The agent tool does not expose arbitrary target URIs or semantic-extraction instructions. " +\n',
    "tool description",
    re.S,
)

plugin = replace_once(
    plugin,
    r'        parameters: Type\.Object\(\{\n.*?\n        \}\),\n        async execute',
    '''        parameters: Type.Object({
          source: Type.String({ description: "Local path, OpenClaw media attachment path, directory path, public URL, or Git URL" }),
          summary: Type.Optional(Type.String({ description: "Required for automatic routing: one short sentence in Russian based on known or inspected resource content, describing its semantic content and purpose. Write it in Russian even for foreign-language sources; technical names and identifiers may remain in their original form. State semantically important provenance naturally, but never guess from or copy raw filename/path/MIME/storage metadata." })),
          category: Type.Optional(Type.String({ description: "Optional explicit override: an existing semantic category key from this agent's taxonomy. The plugin resolves it to a trusted URI; do not provide or invent a URI here." })),
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
          let routingDetails: Record<string, unknown> = {
            mode: deps.resourceRouting?.enabled ? "automatic" : "legacy_default",
          };''',
    "explicit destination removal",
    re.S,
)

plugin = plugin.replace(
    '"Semantic category routing is disabled. Use an explicit to/parent destination or enable resourceRouting.",',
    '"Semantic category routing is disabled. Enable resourceRouting before using an explicit category override.",',
)
plugin = plugin.replace(
    '} else if (!explicitTo && !explicitParent && deps.resourceRouting?.enabled) {',
    '} else if (deps.resourceRouting?.enabled) {',
)

plugin = re.sub(r'\n\s+reason: typeof params\.reason === "string" \? params\.reason : undefined,', '', plugin)
plugin = re.sub(r'\n\s+instruction: typeof params\.instruction === "string" \? params\.instruction : undefined,', '', plugin)
plugin = re.sub(r'\n\s+strict: typeof params\.strict === "boolean" \? params\.strict : undefined,', '', plugin)
plugin = re.sub(r'\n\s+ignoreDirs: typeof params\.ignore_dirs === "string".*?: undefined,', '', plugin)
plugin = re.sub(r'\n\s+include: typeof params\.include === "string".*?: undefined,', '', plugin)
plugin = re.sub(r'\n\s+exclude: typeof params\.exclude === "string".*?: undefined,', '', plugin)
plugin = re.sub(r'\n\s+preserveStructure: typeof params\.preserve_structure === "boolean".*?: undefined,', '', plugin)
plugin = plugin.replace('              to: targetTo,\n', '')

if re.search(r'params\.(?:to|parent|create_parent|reason|instruction|strict|ignore_dirs|include|exclude|preserve_structure)', plugin):
    raise SystemExit("plugin still references a removed agent parameter")

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
| `category` | No | Optional explicit override using an **existing** semantic taxonomy key. The plugin validates the key and resolves the trusted `viking://resources/...` parent URI. |

When `resourceRouting.enabled=true` and `category` is omitted, inspect/read enough of the resource to understand its actual content, then write `summary` in Russian even when the source itself is in another language. Do not infer content from filename/path alone and do not copy raw filename/path/MIME/storage metadata into the summary.

The agent tool deliberately does **not** expose arbitrary `to`/`parent` URIs, `create_parent`, `reason`, `instruction`, parser filters, strictness switches, structure switches, watch controls, tags, or low-level connector arguments. Those remain available only through lower-level/manual interfaces where a human can choose them deliberately.

Automatic routing selects only routeable taxonomy categories. If similarity is below the configured confidence threshold, the configured fallback category (normally `_INBOX`) is used. Routing infrastructure failures fail closed and the resource is not imported.

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

function makeCategory(key: string, uri: string) {
  const segments = uri.split("/");
  return {
    key,
    segment: segments.at(-1) ?? key,
    description: `${key} category`,
    routeable: true,
    uri,
    parentKey: null,
    depth: 1,
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
  const resolveCategory = vi.fn((_agentId: string, key: string) =>
    makeCategory(key, `viking://resources/${key}`));
  const routeAutomatic = options.routeFailure
    ? vi.fn(async () => { throw options.routeFailure; })
    : vi.fn(async () => ({
      category: makeCategory("docs-guides-howtos", "viking://resources/docs/guides/howtos"),
      semanticInput: "Практическое руководство по настройке OpenClaw.",
      decision: {
        categoryKey: "docs-guides-howtos",
        uri: "viking://resources/docs/guides/howtos",
        fallback: false,
        embeddingCandidates: [
          { key: "docs-guides-howtos", description: "Практические инструкции", score: 0.82 },
          { key: "docs-guides-tutorials", description: "Учебные руководства", score: 0.79 },
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
      resolveCategory,
      routeAutomatic,
    },
  });

  return { factories, addResource, getClient, resolveCategory, routeAutomatic };
}

describe("add_resource routing tool", () => {
  it("publishes only the minimal deterministic agent contract", () => {
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

  it("resolves an explicit category key without invoking automatic models", async () => {
    const { factories, resolveCategory, routeAutomatic, addResource } = setup();
    await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/main.js",
      category: "code-source-javascript",
    });
    expect(resolveCategory).toHaveBeenCalledWith("main", "code-source-javascript");
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(addResource).toHaveBeenCalledWith({
      pathOrUrl: "/workspace/main.js",
      parent: "viking://resources/code/source/javascript",
      createParent: true,
      wait: false,
    }, "main_peer");
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

print("Applied minimal agent add_resource contract: source + summary + category")
