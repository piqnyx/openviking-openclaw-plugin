import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), "..");

function pathOf(rel) {
  return resolve(root, rel);
}

function read(rel) {
  return readFileSync(pathOf(rel), "utf8");
}

function write(rel, text) {
  writeFileSync(pathOf(rel), text);
}

function replaceOnce(rel, oldText, newText, label) {
  const text = read(rel);
  const first = text.indexOf(oldText);
  const last = text.lastIndexOf(oldText);
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one match in ${rel}`);
  }
  write(rel, text.slice(0, first) + newText + text.slice(first + oldText.length));
}

function mutate(rel, fn) {
  const before = read(rel);
  const after = fn(before);
  if (after === before) {
    throw new Error(`no changes produced for ${rel}`);
  }
  write(rel, after);
}

const tool = "plugin/openviking-import-tools.ts";

replaceOnce(
  tool,
  `function isOpenVikingNotFoundError(error: unknown): boolean {\n  return error instanceof Error && error.message.includes("OpenViking request failed [NOT_FOUND]");\n}\n`,
  `function isOpenVikingNotFoundError(error: unknown): boolean {\n  return error instanceof Error && error.message.includes("OpenViking request failed [NOT_FOUND]");\n}\n\nfunction isOpenVikingDirectoryRequiresRecursiveError(error: unknown): boolean {\n  return error instanceof Error &&\n    error.message.includes(\n      "OpenViking request failed [FAILED_PRECONDITION]: Cannot remove directory without --recursive:",\n    );\n}\n`,
  "recursive precondition helper",
);

replaceOnce(
  tool,
  `          "Use category only as an explicit override with an existing full taxonomy path such as code/source/javascript, or a stable semantic key for compatibility. Never invent category paths, keys, or resource URIs. Unknown, ambiguous, or organizational category selectors are routed to the configured fallback inbox rather than creating new paths. " +\n`,
  `          "Set category ONLY when the user's current request explicitly names the exact taxonomy destination/path/key. If the user merely asks to add, save, import, upload, or index the resource, NEVER set category: omit it and let automatic routing decide. Never infer, guess, browse for, list, or choose a category from the resource content. Never try alternative categories after a category error. Invalid explicit categories are rejected without importing anything. " +\n`,
  "add_resource category guidance",
);

replaceOnce(
  tool,
  `            description: "Optional explicit override using an existing full taxonomy path such as code/source/javascript. A stable semantic key is also accepted for compatibility. The plugin resolves the selector to a trusted URI; never invent a path/key or provide an arbitrary URI.",\n`,
  `            description: "Use ONLY when the user's current request explicitly names the exact existing writable taxonomy path/key. NEVER infer, guess, browse for, list, or choose category yourself. If the user did not explicitly name a destination, omit category so automatic routing decides.",\n`,
  "category parameter guidance",
);

replaceOnce(
  tool,
  `            const resolved = deps.resourceRouting.resolveCategoryOrFallback(\n              session.agentId,\n              explicitCategory,\n            );\n            targetParent = resolved.category.uri;\n`,
  `            const resolved = deps.resourceRouting.resolveCategoryOrFallback(\n              session.agentId,\n              explicitCategory,\n            );\n            if (resolved.fallback) {\n              return rejectedResourceImport(\n                "Explicit `category` is not an exact writable taxonomy destination. The resource was NOT imported. Do not guess another category. If the user did not explicitly request this exact category, retry once with `category` omitted so automatic routing can decide. If the user explicitly requested it, report that the destination is unavailable or not writable.",\n                {\n                  category: explicitCategory,\n                  matchedBy: resolved.matchedBy,\n                  fallbackReason: resolved.fallbackReason,\n                },\n              );\n            }\n            targetParent = resolved.category.uri;\n`,
  "reject invalid explicit category",
);

mutate(tool, (text) => {
  const marker = `        name: "remove_resource",`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error("remove_resource section not found");
  const execute = text.indexOf("        async execute", start);
  if (execute < 0) throw new Error("remove_resource execute not found");
  let section = text.slice(start, execute);
  const descStart = section.indexOf("        description:");
  const paramsStart = section.indexOf("        parameters: Type.Object({", descStart);
  const paramsEnd = section.lastIndexOf("        }),\n");
  if (descStart < 0 || paramsStart < 0 || paramsEnd < paramsStart) {
    throw new Error("remove_resource schema boundaries not found");
  }
  const replacement = `        description:\n          "Use when the user explicitly asks to delete or remove one imported OpenViking resource/document. " +\n          "This tool is restricted to descendants of viking://resources/ and must never be used for memories, sessions, skills, or the resources root. " +\n          "Provide the exact URI of the imported resource to remove. Exact taxonomy category/container URIs are protected and cannot be removed by this agent tool. " +\n          "The tool handles OpenViking's directory-like document representation internally: it first attempts a non-recursive delete and retries exactly once recursively only for the specific FAILED_PRECONDITION that says the selected resource root is a non-empty directory requiring --recursive. " +\n          "If the transport outcome is unknown, inspect the URI before any deliberate retry. A NOT_FOUND response is treated as already absent.",\n        parameters: Type.Object({\n          uri: Type.String({\n            description: "Exact URI of one imported resource below viking://resources/. Do not pass a taxonomy category/container URI; category roots are protected.",\n          }),\n        }),\n`;
  section = section.slice(0, descStart) + replacement + section.slice(paramsEnd + "        }),\n".length);
  return text.slice(0, start) + section + text.slice(execute);
});

replaceOnce(
  tool,
  `          const session = deps.resolvePluginSessionRouting(ctx);\n          const client = await deps.getClient(session.agentId);\n          let result: RemoveResourceResult;\n          try {\n            result = await client.removeResource({\n              uri: validation.uri,\n              recursive: typeof params.recursive === "boolean" ? params.recursive : undefined,\n              wait: false,\n            }, session.actorPeerId);\n          } catch (error) {\n`,
  `          const session = deps.resolvePluginSessionRouting(ctx);\n          if (deps.resourceRouting?.enabled) {\n            const selector = validation.uri.slice("viking://resources/".length);\n            const categoryResolution = deps.resourceRouting.resolveCategoryOrFallback(\n              session.agentId,\n              selector,\n            );\n            const exactCurrentCategory =\n              !categoryResolution.fallback ||\n              categoryResolution.fallbackReason === "organizational_category";\n            if (exactCurrentCategory) {\n              return rejectedResourceImport(\n                "Refusing to remove a taxonomy category/container. Remove a specific imported resource below that category instead.",\n                { uri: validation.uri, protectedCategory: true },\n              );\n            }\n          }\n\n          const client = await deps.getClient(session.agentId);\n          let result: RemoveResourceResult;\n          try {\n            try {\n              result = await client.removeResource({\n                uri: validation.uri,\n                recursive: false,\n                wait: false,\n              }, session.actorPeerId);\n            } catch (error) {\n              if (!isOpenVikingDirectoryRequiresRecursiveError(error)) {\n                throw error;\n              }\n              result = await client.removeResource({\n                uri: validation.uri,\n                recursive: true,\n                wait: false,\n              }, session.actorPeerId);\n            }\n          } catch (error) {\n`,
  "remove_resource safe recursive fallback",
);

const addRoutingTest = "tests/add-resource-routing-tool.test.ts";
mutate(addRoutingTest, (text) => {
  const start = text.indexOf(`  it("imports an unknown explicit category into fallback inbox instead of losing the resource"`);
  const end = text.indexOf(`  it("returns outcome unknown instead of encouraging an automatic retry after transport failure"`, start);
  if (start < 0 || end < 0) throw new Error("explicit fallback test block not found");
  const replacement = `  it("rejects an invalid explicit category without importing or guessing another destination", async () => {\n    const { factories, resolveCategoryOrFallback, routeAutomatic, addResource } = setup({\n      explicitFallback: true,\n    });\n    const result = await factories.get("add_resource")!({}).execute("call", {\n      source: "/workspace/unknown.md",\n      category: "code/source/javascrpit",\n    }) as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };\n\n    expect(resolveCategoryOrFallback).toHaveBeenCalledWith("main", "code/source/javascrpit");\n    expect(routeAutomatic).not.toHaveBeenCalled();\n    expect(addResource).not.toHaveBeenCalled();\n    expect(result.details).toMatchObject({\n      action: "rejected",\n      category: "code/source/javascrpit",\n      fallbackReason: "unknown_category",\n    });\n    expect(result.content?.[0]?.text).toContain("resource was NOT imported");\n    expect(result.content?.[0]?.text).toContain("Do not guess another category");\n  });\n\n`;
  return text.slice(0, start) + replacement + text.slice(end);
});

const removeTest = "tests/remove-resource.test.ts";
replaceOnce(
  removeTest,
  `    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(["uri", "recursive"]);\n`,
  `    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(["uri"]);\n`,
  "remove schema test",
);
replaceOnce(
  removeTest,
  `    expect(removeResource).toHaveBeenCalledWith({\n      uri: "viking://resources/workspace",\n      recursive: true,\n      wait: false,\n    }, "main_peer");\n`,
  `    expect(removeResource).toHaveBeenCalledWith({\n      uri: "viking://resources/workspace",\n      recursive: false,\n      wait: false,\n    }, "main_peer");\n`,
  "ignore stale recursive agent argument",
);
mutate(removeTest, (text) => {
  const insertAt = text.indexOf(`  it("treats NOT_FOUND as the desired already-absent state"`);
  if (insertAt < 0) throw new Error("NOT_FOUND test insertion point not found");
  const addition = `  it("retries exactly once with recursive=true only for the directory precondition", async () => {\n    const { factories, removeResource } = setupTools({ enableRemoveResourceTool: true });\n    removeResource\n      .mockRejectedValueOnce(new Error(\n        "OpenViking request failed [FAILED_PRECONDITION]: Cannot remove directory without --recursive: viking://resources/workspace",\n      ))\n      .mockResolvedValueOnce({\n        uri: "viking://resources/workspace",\n        estimated_deleted_count: 3,\n        semantic_status: "queued",\n      });\n\n    await factories.get("remove_resource")!({}).execute("call-1", {\n      uri: "viking://resources/workspace",\n      recursive: true,\n      wait: true,\n      timeout: 900,\n    });\n\n    expect(removeResource).toHaveBeenCalledTimes(2);\n    expect(removeResource).toHaveBeenNthCalledWith(1, {\n      uri: "viking://resources/workspace",\n      recursive: false,\n      wait: false,\n    }, "main_peer");\n    expect(removeResource).toHaveBeenNthCalledWith(2, {\n      uri: "viking://resources/workspace",\n      recursive: true,\n      wait: false,\n    }, "main_peer");\n  });\n\n`;
  return text.slice(0, insertAt) + addition + text.slice(insertAt);
});

const guardrailTest = `import { describe, expect, it, vi } from "vitest";\n\nimport { registerOpenVikingImportTools } from "../plugin/openviking-import-tools.js";\n\ntype ToolFactory = (ctx: Record<string, unknown>) => {\n  name: string;\n  parameters: { properties?: Record<string, unknown> };\n  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;\n};\n\nfunction category(key: string, path: string, routeable = true) {\n  return {\n    key,\n    segment: path.split("/").at(-1) ?? key,\n    description: key,\n    distinguishFrom: [],\n    routeable,\n    uri: \`viking://resources/\${path}\`,\n    path,\n    embeddingText: key,\n    rerankText: key,\n    parentKey: null,\n    depth: path.split("/").length,\n  };\n}\n\nfunction setup() {\n  const factories = new Map<string, ToolFactory>();\n  const removeResource = vi.fn(async () => ({\n    uri: "viking://resources/docs/guides/howtos/postgres",\n    estimated_deleted_count: 1,\n    semantic_status: "queued",\n  }));\n  const resolveCategoryOrFallback = vi.fn((_agentId: string, selector: string) => {\n    if (selector === "docs/guides/howtos") {\n      return {\n        requested: selector,\n        category: category("docs-guides-howtos", selector),\n        matchedBy: "path" as const,\n        fallback: false,\n      };\n    }\n    if (selector === "docs") {\n      return {\n        requested: selector,\n        category: category("inbox", "_INBOX"),\n        matchedBy: "fallback" as const,\n        fallback: true,\n        fallbackReason: "organizational_category" as const,\n      };\n    }\n    return {\n      requested: selector,\n      category: category("inbox", "_INBOX"),\n      matchedBy: "fallback" as const,\n      fallback: true,\n      fallbackReason: "unknown_category" as const,\n    };\n  });\n\n  registerOpenVikingImportTools({\n    registerTool: (factory, meta) => factories.set(meta.name, factory as ToolFactory),\n    getClient: vi.fn(async () => ({\n      addResource: vi.fn(),\n      addSkill: vi.fn(),\n      removeResource,\n    })),\n    resolvePluginSessionRouting: () => ({ agentId: "main", actorPeerId: "main_peer" }),\n    isBypassedSession: () => false,\n    makeBypassedToolResult: vi.fn(),\n    enableAddResourceTool: false,\n    enableRemoveResourceTool: true,\n    resourceRouting: {\n      enabled: true,\n      summaryLanguage: "ru",\n      resolveCategoryOrFallback,\n      routeAutomatic: vi.fn(async () => { throw new Error("not used"); }),\n    },\n  });\n\n  return { factories, removeResource };\n}\n\ndescribe("agent resource mutation guardrails", () => {\n  it.each([\n    "viking://resources/docs/guides/howtos",\n    "viking://resources/docs",\n  ])("rejects exact taxonomy category/container URI %s", async (uri) => {\n    const { factories, removeResource } = setup();\n    const result = await factories.get("remove_resource")!({}).execute("call", { uri }) as {\n      details?: Record<string, unknown>;\n    };\n    expect(result.details).toMatchObject({ action: "rejected", protectedCategory: true });\n    expect(removeResource).not.toHaveBeenCalled();\n  });\n\n  it("allows a specific imported resource below a protected category", async () => {\n    const { factories, removeResource } = setup();\n    await factories.get("remove_resource")!({}).execute("call", {\n      uri: "viking://resources/docs/guides/howtos/postgres",\n      recursive: true,\n    });\n    expect(removeResource).toHaveBeenCalledWith({\n      uri: "viking://resources/docs/guides/howtos/postgres",\n      recursive: false,\n      wait: false,\n    }, "main_peer");\n  });\n});\n`;
const guardrailPath = pathOf("tests/resource-mutation-guardrails.test.ts");
if (existsSync(guardrailPath)) {
  throw new Error("tests/resource-mutation-guardrails.test.ts already exists");
}
writeFileSync(guardrailPath, guardrailTest);

const skill = "skills/openviking-context-database/SKILL.md";
replaceOnce(
  skill,
  `| \`category\` | No | Explicit override using an existing full taxonomy path such as \`code/source/javascript\`; stable semantic keys remain accepted for compatibility. |\n`,
  `| \`category\` | No | Use ONLY when the user's current request explicitly names the exact existing writable taxonomy path/key. Never choose it yourself. |\n`,
  "skill category table",
);
replaceOnce(
  skill,
  `Explicit category selection is deterministic and model-free. The plugin accepts only categories from the validated taxonomy. Unknown, ambiguous, or organizational selectors are sent to the configured fallback inbox; they never create a new arbitrary path.\n`,
  `**NEVER set \`category\` unless the user's current request explicitly names the exact taxonomy destination/path/key.** If the user merely asks to add/save/import/upload/index a resource, omit \`category\` and use automatic routing. Never infer, guess, browse for, list, or choose a category from the resource content. Never try alternative categories after a category error.\n\nExplicit category selection is deterministic and model-free. Unknown, ambiguous, or organizational selectors are rejected without importing anything. If the user did not explicitly request that exact category, retry once with \`category\` omitted so automatic routing can decide. If the user did request it, report that the destination is unavailable or not writable.\n`,
  "skill explicit category policy",
);
replaceOnce(
  skill,
  `| \`recursive\` | No | Remove an entire non-empty resource subtree; defaults to \`false\`. |\n`,
  ``,
  "skill remove recursive row",
);
replaceOnce(
  skill,
  `The agent tool always calls OpenViking with \`wait=false\`. The filesystem deletion completes before OpenViking returns, while semantic/index refresh may continue with \`semantic_status=queued\`. \`NOT_FOUND\` is reported as already absent. If the transport fails without an HTTP response, the mutation outcome is unknown; inspect the URI before any deliberate retry and never repeat the delete automatically.\n`,
  `The agent tool exposes only \`uri\` and always calls OpenViking with \`wait=false\`. Exact taxonomy category/container URIs are protected from agent deletion. For one specific imported document/resource root, the plugin first attempts a non-recursive delete and retries exactly once recursively only when OpenViking returns the specific non-empty-directory \`FAILED_PRECONDITION\`. The recursive fallback is internal and is never selected by the model. The filesystem deletion completes before OpenViking returns, while semantic/index refresh may continue with \`semantic_status=queued\`. \`NOT_FOUND\` is reported as already absent. If the transport fails without an HTTP response, the mutation outcome is unknown; inspect the URI before any deliberate retry and never repeat the delete automatically.\n`,
  "skill remove policy",
);

const skillTest = "tests/agent-skill-contract.test.ts";
replaceOnce(
  skillTest,
  `    expect(text).toContain("| \`recursive\` | No |");\n`,
  `    expect(text).not.toContain("| \`recursive\` |");\n    expect(text).toContain("taxonomy category/container URIs are protected");\n    expect(text).toContain("retries exactly once recursively");\n`,
  "skill contract remove expectations",
);

unlinkSync(self);
console.log("ISSUE30_PATCH_OK");
