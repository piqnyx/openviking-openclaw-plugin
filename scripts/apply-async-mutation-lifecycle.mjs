import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, text) { fs.writeFileSync(path, text); }
function replaceOnce(text, from, to, label) {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`missing replacement target: ${label}`);
  if (text.indexOf(from, first + from.length) >= 0) throw new Error(`ambiguous replacement target: ${label}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}
function replaceRegexOnce(text, re, to, label) {
  const matches = [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
  if (matches.length !== 1) throw new Error(`${label}: expected 1 match, got ${matches.length}`);
  return text.replace(re, to);
}

// ---- Agent-facing import tools -------------------------------------------------
{
  const p = 'plugin/openviking-import-tools.ts';
  let s = read(p);

  s = replaceOnce(s,
`type RoutedAddResourceInput = AddResourceInput & {
  createParent?: boolean;
};

export type OpenVikingImportClient = {
  addResource: (input: RoutedAddResourceInput, agentId?: string) => Promise<AddResourceResult>;
  removeResource: (input: RemoveResourceInput, agentId?: string) => Promise<RemoveResourceResult>;
  addSkill: (input: AddSkillInput, agentId?: string) => Promise<AddSkillResult>;
};`,
`type RoutedAddResourceInput = AddResourceInput & {
  createParent?: boolean;
};

type AsyncAddResourceResult = AddResourceResult & { task_id?: string };
type AsyncAddSkillResult = AddSkillResult & { task_id?: string };

export type OpenVikingImportClient = {
  addResource: (input: RoutedAddResourceInput, agentId?: string) => Promise<AsyncAddResourceResult>;
  removeResource: (input: RemoveResourceInput, agentId?: string) => Promise<RemoveResourceResult>;
  addSkill: (input: AddSkillInput, agentId?: string) => Promise<AsyncAddSkillResult>;
};`, 'async result types');

  s = replaceRegexOnce(s,
/function formatResourceImportText\(result: AddResourceResult\): string \{[\s\S]*?\n\}\n\nfunction formatResourceRemovalText/,
`function formatResourceImportText(result: AsyncAddResourceResult): string {
  const root = result.root_uri ? \` Resource: \${result.root_uri}.\` : "";
  const task = result.task_id ? \` Task: \${result.task_id}.\` : "";
  const warnings = result.warnings?.length ? \` Warnings: \${result.warnings.join("; ")}\` : "";
  if (result.status === "error") {
    const errors = result.errors?.length ? \` \${result.errors.join("; ")}\` : "";
    return \`OpenViking resource import was not accepted.\${errors}\${warnings}\`.trim();
  }
  return \`OpenViking accepted the resource for asynchronous processing.\${root}\${task}\${warnings}\`.trim();
}

function formatResourceRemovalText`, 'resource formatter');

  s = replaceOnce(s,
`details.push("semantic refresh queued; consistency work is still pending");`,
`details.push("semantic refresh queued; consistency work continues asynchronously");`, 'remove queued wording');

  s = replaceRegexOnce(s,
/function formatSkillImportText\(result: AddSkillResult\): string \{[\s\S]*?\n\}\n\nfunction rejectedResourceImport/,
`function formatSkillImportText(result: AsyncAddSkillResult): string {
  const uri = result.uri ? \` Skill: \${result.uri}.\` : "";
  const name = result.name ? \` Name: \${result.name}.\` : "";
  const task = result.task_id ? \` Task: \${result.task_id}.\` : "";
  if (result.status === "error") {
    return "OpenViking skill import was not accepted.";
  }
  return \`OpenViking accepted the skill for asynchronous processing.\${name}\${uri}\${task}\`.trim();
}

function rejectedResourceImport`, 'skill formatter');

  s = replaceOnce(s,
`function rejectedResourceImport(message: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { action: "rejected", ...details },
  };
}

function inferResourceSourceMetadata`,
`function rejectedResourceImport(message: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { action: "rejected", ...details },
  };
}

function mutationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A fetch rejection means the client never received an HTTP response. For a
 * mutating request that does not prove the server failed the operation: the
 * request may have reached OpenViking before the connection died or the local
 * AbortController fired. Treat the outcome as unknown and force state
 * inspection before any retry.
 */
function isAmbiguousMutationTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return true;
  }
  return /(?:fetch failed|network error|socket hang up|ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|UND_ERR_|terminated)/i.test(
    error.message,
  );
}

function isOpenVikingNotFoundError(error: unknown): boolean {
  return error instanceof Error && /OpenViking request failed\s*\[NOT_FOUND\]/i.test(error.message);
}

function unknownMutationResult(options: {
  action: string;
  mutation: "add_resource" | "remove_resource" | "add_skill";
  message: string;
  error: unknown;
  details?: Record<string, unknown>;
}) {
  return {
    content: [{ type: "text" as const, text: options.message }],
    details: {
      action: options.action,
      outcome: "unknown",
      mutation: options.mutation,
      retry_safe: false,
      error: mutationErrorMessage(options.error),
      ...(options.details ?? {}),
    },
  };
}

function inferResourceSourceMetadata`, 'mutation helpers');

  s = replaceOnce(s,
`          "Use category only for an existing semantic category key from the configured taxonomy; never invent category keys or resource URIs. Explicit to/parent/category bypass automatic classification.",`,
`          "Use category only for an existing semantic category key from the configured taxonomy; never invent category keys or resource URIs. Explicit to/parent/category bypass automatic classification. " +
          "This agent tool always submits imports asynchronously and returns after OpenViking accepts the job. Never retry the same import automatically after an outcome-unknown transport failure; inspect OpenViking state first.",`, 'add_resource description');

  s = replaceOnce(s,
`          instruction: Type.Optional(Type.String({ description: "Processing instruction for OpenViking semantic extraction" })),
          wait: Type.Optional(Type.Boolean({ description: "Wait for processing to complete" })),
          timeout: Type.Optional(Type.Number({ description: "Timeout in seconds when wait is true" })),`,
`          instruction: Type.Optional(Type.String({ description: "Processing instruction for OpenViking semantic extraction" })),`, 'add_resource schema wait timeout');

  s = replaceOnce(s,
`          const client = await deps.getClient(session.agentId);
          const result = await client.addResource({
            pathOrUrl: source,
            to: targetTo,
            parent: targetParent,
            createParent,
            reason: typeof params.reason === "string" ? params.reason : undefined,
            instruction: typeof params.instruction === "string" ? params.instruction : undefined,
            wait: typeof params.wait === "boolean" ? params.wait : undefined,
            timeout: typeof params.timeout === "number" ? params.timeout : undefined,
          }, session.actorPeerId);
          return {
            content: [{ type: "text" as const, text: formatResourceImportText(result) }],
            details: {
              action: "resource_imported",
              routing: routingDetails,
              ...result,
            },
          };`,
`          const client = await deps.getClient(session.agentId);
          let result: AsyncAddResourceResult;
          try {
            result = await client.addResource({
              pathOrUrl: source,
              to: targetTo,
              parent: targetParent,
              createParent,
              reason: typeof params.reason === "string" ? params.reason : undefined,
              instruction: typeof params.instruction === "string" ? params.instruction : undefined,
              wait: false,
            }, session.actorPeerId);
          } catch (error) {
            if (isAmbiguousMutationTransportError(error)) {
              return unknownMutationResult({
                action: "resource_import_outcome_unknown",
                mutation: "add_resource",
                message:
                  "OpenViking resource import outcome is unknown because the transport failed without an HTTP response. Do not submit the same import again automatically. Inspect OpenViking resources first, then retry only if the resource/job is confirmed absent.",
                error,
                details: { source, routing: routingDetails },
              });
            }
            throw error;
          }
          return {
            content: [{ type: "text" as const, text: formatResourceImportText(result) }],
            details: {
              action: result.status === "error" ? "resource_import_failed" : "resource_import_accepted",
              processing: result.status === "error" ? "failed" : "asynchronous",
              routing: routingDetails,
              ...result,
            },
          };`, 'add_resource execution');

  s = replaceOnce(s,
`          "To clear all resources, first use ov_list on viking://resources, then remove each top-level child; the viking://resources root itself cannot be deleted. " +
          "Set recursive=true for a non-empty resource directory. Set wait=true when subsequent work must wait for OpenViking semantic refresh to finish.",`,
`          "To clear all resources, first use ov_list on viking://resources, then remove each top-level child; the viking://resources root itself cannot be deleted. " +
          "Set recursive=true for a non-empty resource directory. The resource deletion itself is submitted without waiting for semantic refresh; OpenViking may continue semantic/index consistency work asynchronously. " +
          "If the transport outcome is unknown, inspect the URI before any deliberate retry. A NOT_FOUND response is treated as already absent.",`, 'remove description');

  s = replaceOnce(s,
`          recursive: Type.Optional(Type.Boolean({
            description: "Remove the entire subtree below uri. Required for non-empty resource directories; default false.",
          })),
          wait: Type.Optional(Type.Boolean({
            description: "Wait for OpenViking semantic refresh associated with the removal to complete. The agent tool defaults to true; set false only when asynchronous cleanup is explicitly desired.",
          })),
          timeout: Type.Optional(Type.Number({
            description: "Server-side wait timeout in seconds when wait=true.",
          })),`,
`          recursive: Type.Optional(Type.Boolean({
            description: "Remove the entire subtree below uri. Required for non-empty resource directories; default false.",
          })),`, 'remove schema wait timeout');

  s = replaceOnce(s,
`          const session = deps.resolvePluginSessionRouting(ctx);
          const client = await deps.getClient(session.agentId);
          const result = await client.removeResource({
            uri: validation.uri,
            recursive: typeof params.recursive === "boolean" ? params.recursive : undefined,
            wait: typeof params.wait === "boolean" ? params.wait : true,
            timeout: typeof params.timeout === "number" ? params.timeout : undefined,
          }, session.actorPeerId);
          return {
            content: [{ type: "text" as const, text: formatResourceRemovalText(result, validation.uri) }],
            details: {
              action: "resource_removed",
              ...result,
              uri: result.uri ?? validation.uri,
            },
          };`,
`          const session = deps.resolvePluginSessionRouting(ctx);
          const client = await deps.getClient(session.agentId);
          let result: RemoveResourceResult;
          try {
            result = await client.removeResource({
              uri: validation.uri,
              recursive: typeof params.recursive === "boolean" ? params.recursive : undefined,
              wait: false,
            }, session.actorPeerId);
          } catch (error) {
            if (isOpenVikingNotFoundError(error)) {
              return {
                content: [{
                  type: "text" as const,
                  text: `OpenViking resource is already absent: ${validation.uri}.`,
                }],
                details: {
                  action: "resource_absent",
                  uri: validation.uri,
                  already_absent: true,
                },
              };
            }
            if (isAmbiguousMutationTransportError(error)) {
              return unknownMutationResult({
                action: "resource_remove_outcome_unknown",
                mutation: "remove_resource",
                message:
                  `OpenViking removal outcome is unknown for ${validation.uri} because the transport failed without an HTTP response. Do not repeat the delete automatically. Inspect the URI first; retry only if it is still present.`,
                error,
                details: { uri: validation.uri },
              });
            }
            throw error;
          }
          return {
            content: [{ type: "text" as const, text: formatResourceRemovalText(result, validation.uri) }],
            details: {
              action: "resource_removed",
              processing: result.semantic_status === "queued" ? "semantic_refresh_queued" : undefined,
              ...result,
              uri: result.uri ?? validation.uri,
            },
          };`, 'remove execution');

  s = replaceOnce(s,
`      description:
        "Use only when the user explicitly asks to import, add, install, or register a skill into OpenViking. " +
        "Set source to a local SKILL.md file or skill directory, or data to raw SKILL.md content or an MCP tool dict.",`,
`      description:
        "Use only when the user explicitly asks to import, add, install, or register a skill into OpenViking. " +
        "Set source to a local SKILL.md file or skill directory, or data to raw SKILL.md content or an MCP tool dict. " +
        "This agent tool always submits the import asynchronously. Never retry the same skill import automatically after an outcome-unknown transport failure; inspect OpenViking state first.",`, 'add_skill description');

  s = replaceOnce(s,
`        source: Type.Optional(Type.String({ description: "Local SKILL.md path or skill directory path" })),
        data: Type.Optional(Type.Any({ description: "Raw SKILL.md content or MCP tool dict" })),
        wait: Type.Optional(Type.Boolean({ description: "Wait for processing to complete" })),
        timeout: Type.Optional(Type.Number({ description: "Timeout in seconds when wait is true" })),`,
`        source: Type.Optional(Type.String({ description: "Local SKILL.md path or skill directory path" })),
        data: Type.Optional(Type.Any({ description: "Raw SKILL.md content or MCP tool dict" })),`, 'add_skill schema wait timeout');

  s = replaceOnce(s,
`        const session = deps.resolvePluginSessionRouting(ctx);
        const client = await deps.getClient(session.agentId);
        const result = await client.addSkill({
          path: typeof params.source === "string" ? params.source : undefined,
          data: params.data,
          wait: typeof params.wait === "boolean" ? params.wait : undefined,
          timeout: typeof params.timeout === "number" ? params.timeout : undefined,
        }, session.actorPeerId);
        return {
          content: [{ type: "text" as const, text: formatSkillImportText(result) }],
          details: {
            action: "skill_imported",
            ...result,
          },
        };`,
`        const session = deps.resolvePluginSessionRouting(ctx);
        const client = await deps.getClient(session.agentId);
        let result: AsyncAddSkillResult;
        try {
          result = await client.addSkill({
            path: typeof params.source === "string" ? params.source : undefined,
            data: params.data,
            wait: false,
          }, session.actorPeerId);
        } catch (error) {
          if (isAmbiguousMutationTransportError(error)) {
            return unknownMutationResult({
              action: "skill_import_outcome_unknown",
              mutation: "add_skill",
              message:
                "OpenViking skill import outcome is unknown because the transport failed without an HTTP response. Do not submit the same skill again automatically. Inspect OpenViking skills first, then retry only if it is confirmed absent.",
              error,
            });
          }
          throw error;
        }
        return {
          content: [{ type: "text" as const, text: formatSkillImportText(result) }],
          details: {
            action: result.status === "error" ? "skill_import_failed" : "skill_import_accepted",
            processing: result.status === "error" ? "failed" : "asynchronous",
            ...result,
          },
        };`, 'add_skill execution');

  write(p, s);
}

// ---- Existing regression tests -------------------------------------------------
{
  const p = 'tests/add-resource-routing-tool.test.ts';
  let s = read(p);
  s = replaceOnce(s,
`  const addResource = vi.fn(async () => ({
    status: "success",
    root_uri: "viking://resources/result",
  }));`,
`  const addResource = vi.fn(async () => ({
    status: "success",
    root_uri: "viking://resources/result",
    task_id: "task-resource-1",
  }));`, 'routing test task id');
  s = replaceOnce(s,
`      "reason",
      "instruction",
      "wait",
      "timeout",
    ]);`,
`      "reason",
      "instruction",
    ]);`, 'routing tool schema');
  s = replaceOnce(s,
`      source: "/workspace/draft/guide.md",
      summary: "A setup guide for configuring OpenClaw.",
      wait: true,
    }) as { details?: Record<string, unknown> };`,
`      source: "/workspace/draft/guide.md",
      summary: "A setup guide for configuring OpenClaw.",
      wait: true,
      timeout: 1,
    }) as { details?: Record<string, unknown> };`, 'routing injected wait');
  s = replaceOnce(s,
`      parent: "viking://resources/documents/guides",
      createParent: true,
      wait: true,
    }), "main_peer");
    expect(result.details?.routing).toMatchObject({`,
`      parent: "viking://resources/documents/guides",
      createParent: true,
      wait: false,
    }), "main_peer");
    expect(addResource.mock.calls[0]?.[0]).not.toHaveProperty("timeout");
    expect(result.details).toMatchObject({
      action: "resource_import_accepted",
      processing: "asynchronous",
      task_id: "task-resource-1",
    });
    expect(result.details?.routing).toMatchObject({`, 'routing forced async');
  s = replaceOnce(s,
`  it("does not import when automatic-routing infrastructure fails", async () => {`,
`  it("returns outcome unknown instead of encouraging an automatic retry after transport failure", async () => {
    const { factories, addResource } = setup();
    addResource.mockRejectedValueOnce(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/guide.md",
      summary: "A setup guide.",
    }) as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };
    expect(result.details).toMatchObject({
      action: "resource_import_outcome_unknown",
      outcome: "unknown",
      retry_safe: false,
    });
    expect(result.content?.[0]?.text).toContain("Do not submit the same import again automatically");
  });

  it("does not import when automatic-routing infrastructure fails", async () => {`, 'routing ambiguous transport test');
  write(p, s);
}

{
  const p = 'tests/remove-resource.test.ts';
  let s = read(p);
  s = replaceOnce(s,
`  const removeResource = vi.fn(async () => ({
    uri: "viking://resources/workspace",
    estimated_deleted_count: 6,
    semantic_status: "complete",
  }));`,
`  const removeResource = vi.fn(async () => ({
    uri: "viking://resources/workspace",
    estimated_deleted_count: 6,
    semantic_status: "queued",
  }));`, 'remove test queued stub');
  s = replaceOnce(s,
`  it("publishes uri, recursive, wait, and timeout parameters", () => {
    const { factories } = setupTools({ enableRemoveResourceTool: true });
    const tool = factories.get("remove_resource")!({});
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual([
      "uri",
      "recursive",
      "wait",
      "timeout",
    ]);
  });`,
`  it("publishes only deletion intent and keeps wait/timeout away from the agent", () => {
    const { factories } = setupTools({ enableRemoveResourceTool: true });
    const tool = factories.get("remove_resource")!({});
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(["uri", "recursive"]);
  });`, 'remove agent schema');
  s = replaceOnce(s,
`  it("routes a valid removal through the current agent account and preserves all parameters", async () => {`,
`  it("routes a valid removal through the current agent account and always uses wait=false", async () => {`, 'remove test title');
  s = replaceOnce(s,
`    expect(removeResource).toHaveBeenCalledWith({
      uri: "viking://resources/workspace",
      recursive: true,
      wait: true,
      timeout: 900,
    }, "main_peer");
    expect(result.details).toMatchObject({
      action: "resource_removed",
      uri: "viking://resources/workspace",
      estimated_deleted_count: 6,
      semantic_status: "complete",
    });`,
`    expect(removeResource).toHaveBeenCalledWith({
      uri: "viking://resources/workspace",
      recursive: true,
      wait: false,
    }, "main_peer");
    expect(result.details).toMatchObject({
      action: "resource_removed",
      processing: "semantic_refresh_queued",
      uri: "viking://resources/workspace",
      estimated_deleted_count: 6,
      semantic_status: "queued",
    });`, 'remove forced async expectation');
  s = replaceOnce(s,
`  });
});

describe("remove_resource config gating", () => {`,
`  });

  it("treats NOT_FOUND as the desired already-absent state", async () => {
    const { factories, removeResource } = setupTools({ enableRemoveResourceTool: true });
    removeResource.mockRejectedValueOnce(new Error("OpenViking request failed [NOT_FOUND]: missing"));
    const result = await factories.get("remove_resource")!({}).execute("call-1", {
      uri: "viking://resources/workspace",
    }) as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };
    expect(result.details).toMatchObject({
      action: "resource_absent",
      already_absent: true,
      uri: "viking://resources/workspace",
    });
    expect(result.content?.[0]?.text).toContain("already absent");
  });

  it("returns outcome unknown after an ambiguous transport failure and does not retry", async () => {
    const { factories, removeResource } = setupTools({ enableRemoveResourceTool: true });
    removeResource.mockRejectedValueOnce(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    const result = await factories.get("remove_resource")!({}).execute("call-1", {
      uri: "viking://resources/workspace",
    }) as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };
    expect(removeResource).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      action: "resource_remove_outcome_unknown",
      outcome: "unknown",
      retry_safe: false,
    });
    expect(result.content?.[0]?.text).toContain("Do not repeat the delete automatically");
  });
});

describe("remove_resource config gating", () => {`, 'remove ambiguity tests');
  write(p, s);
}

// Dedicated add_skill lifecycle regression.
write('tests/agent-import-lifecycle.test.ts', `import { describe, expect, it, vi } from "vitest";

import { registerOpenVikingImportTools } from "../plugin/openviking-import-tools.js";

type ToolFactory = (ctx: Record<string, unknown>) => {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

function setup() {
  const factories = new Map<string, ToolFactory>();
  const addSkill = vi.fn(async () => ({
    status: "success",
    uri: "viking://agent/skills/demo",
    task_id: "task-skill-1",
  }));
  registerOpenVikingImportTools({
    registerTool: (factory, meta) => factories.set(meta.name, factory as ToolFactory),
    getClient: vi.fn(async () => ({
      addResource: vi.fn(),
      removeResource: vi.fn(),
      addSkill,
    })),
    resolvePluginSessionRouting: () => ({ agentId: "main", actorPeerId: "main_peer" }),
    isBypassedSession: () => false,
    makeBypassedToolResult: vi.fn(),
    enableAddResourceTool: false,
    enableRemoveResourceTool: false,
  });
  return { factories, addSkill };
}

describe("agent-facing asynchronous import lifecycle", () => {
  it("keeps add_skill wait/timeout out of the schema and forces wait=false", async () => {
    const { factories, addSkill } = setup();
    const tool = factories.get("add_skill")!({ agentId: "main" });
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(["source", "data"]);
    const result = await tool.execute("call", {
      source: "/workspace/SKILL.md",
      wait: true,
      timeout: 1,
    }) as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };
    expect(addSkill).toHaveBeenCalledWith({
      path: "/workspace/SKILL.md",
      data: undefined,
      wait: false,
    }, "main_peer");
    expect(result.details).toMatchObject({
      action: "skill_import_accepted",
      processing: "asynchronous",
      task_id: "task-skill-1",
    });
    expect(result.content?.[0]?.text).toContain("asynchronous processing");
  });

  it("reports an unknown outcome instead of silently retrying a skill mutation", async () => {
    const { factories, addSkill } = setup();
    addSkill.mockRejectedValueOnce(Object.assign(new Error("fetch failed: ECONNRESET"), { name: "TypeError" }));
    const result = await factories.get("add_skill")!({}).execute("call", { data: { name: "demo" } }) as {
      details?: Record<string, unknown>;
    };
    expect(addSkill).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      action: "skill_import_outcome_unknown",
      outcome: "unknown",
      retry_safe: false,
    });
  });
});
`);

// ---- Release metadata and README ----------------------------------------------
{
  const pkgPath = 'package.json';
  const pkg = JSON.parse(read(pkgPath));
  pkg.version = '2026.7.15-isolation.8';
  pkg.repository = { type: 'git', url: 'https://github.com/piqnyx/openviking-openclaw-plugin.git' };
  pkg.homepage = 'https://github.com/piqnyx/openviking-openclaw-plugin';
  pkg.bugs = { url: 'https://github.com/piqnyx/openviking-openclaw-plugin/issues' };
  write(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  const lockPath = 'package-lock.json';
  const lock = JSON.parse(read(lockPath));
  lock.version = '2026.7.15-isolation.8';
  if (lock.packages?.['']) lock.packages[''].version = '2026.7.15-isolation.8';
  write(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

{
  const p = 'README.md';
  let s = read(p);
  s = s.replaceAll('2026.7.15-isolation.7', '2026.7.15-isolation.8');
  s = replaceOnce(s,
`Release \`isolation.7\` adds configurable resource routing:`,
`Release \`isolation.7\` added configurable resource routing. Release \`isolation.8\` hardens the agent-facing mutation lifecycle:`, 'README release intro');
  s = replaceOnce(s,
`| Tests / CI | Cover routing config, taxonomy validation, model responses, cache invalidation, decisions, audit, tool behavior, startup preload, and create-parent parity. |

The memory/session/account-isolation path`,
`| Tests / CI | Cover routing config, taxonomy validation, model responses, cache invalidation, decisions, audit, tool behavior, startup preload, and create-parent parity. |

Release \`isolation.8\` changes only the agent-facing mutation contract, not the low-level OpenViking client:

| Area | Change |
| --- | --- |
| \`plugin/openviking-import-tools.ts\` | Removes \`wait\`/\`timeout\` from agent-visible \`add_resource\`, \`remove_resource\`, and \`add_skill\`; all three submit with \`wait=false\`. |
| Mutation error handling | A transport failure without an HTTP response is reported as outcome-unknown and must not be retried automatically. |
| \`remove_resource\` | Treats OpenViking \`NOT_FOUND\` as already absent and returns queued semantic-refresh state without making the agent wait. |
| Result reporting | Async imports report accepted/queued semantics and preserve OpenViking \`task_id\` when present. |
| Manual/internal API | Low-level client and slash-command wait/timeout controls remain available for deliberate operator workflows. |

The memory/session/account-isolation path`, 'README isolation8 table');

  s = replaceRegexOnce(s,
/## `remove_resource`[\s\S]*?### Tool groups/,
`## Agent mutation lifecycle

The agent-facing mutation tools intentionally do not expose OpenViking's \`wait\` or \`timeout\` controls. Long-running parsing, VLM work, embeddings, semantic refresh, and index consistency are server-side jobs; keeping an LLM tool call open for them creates false timeout failures and encourages duplicate mutations.

The agent contract is therefore:

- \`add_resource\`: route/validate, submit with \`wait=false\`, return accepted state plus \`root_uri\`/\`task_id\` when OpenViking provides them;
- \`add_skill\`: submit with \`wait=false\` and return accepted state/task metadata;
- \`remove_resource\`: delete with \`wait=false\`; filesystem deletion is completed by OpenViking before the response while semantic refresh may continue with \`semantic_status=queued\`.

This restriction applies only to agent-visible tools. The low-level client and manual slash-command paths keep their explicit \`wait\`/\`timeout\` capabilities for operator workflows that deliberately need synchronous completion.

A network/transport timeout on a mutating request does not prove the server rejected the operation. If the client receives no HTTP response, the tool reports \`outcome=unknown\` and \`retry_safe=false\`; the agent is instructed to inspect OpenViking state before any retry. This avoids the classic failure mode where the first import was accepted, its response was lost, and a second automatic call creates a duplicate job.

## \`remove_resource\`

\`remove_resource\` deletes a file or directory below \`viking://resources/\` through the OpenViking filesystem API.

Example agent-level parameters:

\`\`\`json
{
  "uri": "viking://resources/workspace",
  "recursive": true
}
\`\`\`

### Safety boundary

The tool accepts only descendants of:

\`\`\`text
viking://resources/
\`\`\`

It refuses:

- \`viking://resources\` itself;
- memories, sessions, skills, and other namespaces;
- empty path segments;
- raw \`.\` or \`..\` path segments;
- raw backslash path separators;
- ambiguous raw \`?\` suffixes.

The validator intentionally does **not** percent-decode Viking URI path components. OpenViking treats percent sequences in the received Viking URI as literal path data; the plugin does not invent a second decoding step before a destructive operation.

To remove all resources, list \`viking://resources\` first and remove its top-level children individually. The root itself cannot be deleted through this tool.

### Recursive deletion

\`recursive\` defaults to \`false\`, matching the OpenViking API. A non-empty directory therefore requires:

\`\`\`json
{
  "recursive": true
}
\`\`\`

The plugin does not silently promote a failed non-recursive request into a recursive delete.

### Asynchronous consistency

The agent-facing tool always calls OpenViking with \`wait=false\`. OpenViking performs the filesystem deletion before returning, while semantic/index consistency work may remain queued. The plugin does not perform its own vector deletion, reindex, relation repair, or semantic refresh.

The structured OpenViking result is propagated in tool \`details\`, including fields such as \`uri\`, \`estimated_deleted_count\`, \`memory_cleanup\`, \`semantic_root_uri\`, \`semantic_status\`, and \`queue_status\` when the server returns them.

A successful asynchronous removal commonly returns \`semantic_status=queued\`. That means the requested resource was removed and semantic refresh continues on the server; it is not a deletion timeout.

OpenViking \`NOT_FOUND\` is treated as \`resource_absent\`, because the requested end state is already true. Transport failures without an HTTP response are different: the tool returns outcome-unknown and refuses to imply that an automatic retry is safe.

### Tool groups`, 'README remove section');
  write(p, s);
}

console.log('async mutation lifecycle patch applied');
