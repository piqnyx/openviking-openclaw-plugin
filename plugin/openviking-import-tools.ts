import { basename, extname } from "node:path";

import { Type } from "@sinclair/typebox";

import { validateRemovableResourceUri } from "../client.js";
import type {
  AddResourceInput,
  AddResourceResult,
  RemoveResourceInput,
  RemoveResourceResult,
  AddSkillInput,
  AddSkillResult,
} from "../client.js";
import type { ResourceRoutingService } from "../routing/resource-routing-service.js";

export type OpenVikingImportToolContext = {
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  senderId?: string;
  requesterSenderId?: string;
};

export type OpenVikingImportSession = {
  sessionId?: string;
  sessionKey?: string;
  ovSessionId?: string;
  agentId: string;
  actorPeerId?: string;
};

type RoutedAddResourceInput = AddResourceInput & {
  createParent?: boolean;
};

type AsyncAddResourceResult = AddResourceResult & { task_id?: string };
type AsyncAddSkillResult = AddSkillResult & { task_id?: string };

export type OpenVikingImportClient = {
  addResource: (input: RoutedAddResourceInput, agentId?: string) => Promise<AsyncAddResourceResult>;
  removeResource: (input: RemoveResourceInput, agentId?: string) => Promise<RemoveResourceResult>;
  addSkill: (input: AddSkillInput, agentId?: string) => Promise<AsyncAddSkillResult>;
};

export type OpenVikingImportToolsDeps = {
  registerTool: (toolOrFactory: unknown, opts: { name: string }) => void;
  getClient: (agentId: string | undefined) => Promise<OpenVikingImportClient>;
  resolvePluginSessionRouting: (ctx?: OpenVikingImportToolContext) => OpenVikingImportSession;
  isBypassedSession: (ctx?: OpenVikingImportToolContext) => boolean;
  makeBypassedToolResult: (toolName: string) => unknown;
  enableAddResourceTool: boolean;
  enableRemoveResourceTool: boolean;
  resourceRouting?: Pick<
    ResourceRoutingService,
    "enabled" | "resolveCategoryOrFallback" | "routeAutomatic"
  >;
};

function formatResourceImportText(result: AsyncAddResourceResult): string {
  const root = result.root_uri ? ` Resource: ${result.root_uri}.` : "";
  const task = result.task_id ? ` Task: ${result.task_id}.` : "";
  const warnings = result.warnings?.length ? ` Warnings: ${result.warnings.join("; ")}` : "";
  if (result.status === "error") {
    const errors = result.errors?.length ? ` ${result.errors.join("; ")}` : "";
    return `OpenViking resource import was not accepted.${errors}${warnings}`.trim();
  }
  return `OpenViking accepted the resource for asynchronous processing.${root}${task}${warnings}`.trim();
}

function formatResourceRemovalText(result: RemoveResourceResult, requestedUri: string): string {
  const uri = result.uri ?? requestedUri;
  const details: string[] = [];
  if (typeof result.estimated_deleted_count === "number") {
    details.push(`estimated deleted entries: ${result.estimated_deleted_count}`);
  }
  if (result.semantic_status === "complete") {
    details.push("semantic refresh complete");
  } else if (result.semantic_status === "queued") {
    details.push("semantic refresh queued; consistency work continues asynchronously");
  } else if (result.semantic_status === "failed") {
    details.push("semantic refresh failed after resource removal");
  } else if (result.semantic_status) {
    details.push(`semantic status: ${result.semantic_status}`);
  }
  return `Removed OpenViking resource: ${uri}.${details.length ? ` ${details.join("; ")}.` : ""}`;
}

function formatSkillImportText(result: AsyncAddSkillResult): string {
  const uri = result.uri ? ` Skill: ${result.uri}.` : "";
  const name = result.name ? ` Name: ${result.name}.` : "";
  const task = result.task_id ? ` Task: ${result.task_id}.` : "";
  if (result.status === "error") {
    return "OpenViking skill import was not accepted.";
  }
  return `OpenViking accepted the skill for asynchronous processing.${name}${uri}${task}`.trim();
}

function rejectedResourceImport(message: string, details: Record<string, unknown> = {}) {
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
  return error instanceof Error && error.message.includes("OpenViking request failed [NOT_FOUND]");
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

function inferResourceSourceMetadata(source: string): {
  sourceKind: string;
  filename?: string;
  extension?: string;
} {
  const trimmed = source.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const filename = basename(parsed.pathname) || undefined;
      return {
        sourceKind: "web_url",
        filename,
        extension: filename ? extname(filename).replace(/^\./, "") || undefined : undefined,
      };
    } catch {
      return { sourceKind: "web_url" };
    }
  }
  if (/^(?:git@|ssh:\/\/|git:\/\/)/i.test(trimmed) || /\.git\/?$/i.test(trimmed)) {
    const withoutQuery = trimmed.split(/[?#]/, 1)[0].replace(/\/+$/, "");
    const filename = basename(withoutQuery).replace(/\.git$/i, "") || undefined;
    return { sourceKind: "git", filename };
  }
  const filename = basename(trimmed) || undefined;
  return {
    sourceKind: "local_path",
    filename,
    extension: filename ? extname(filename).replace(/^\./, "") || undefined : undefined,
  };
}

/**
 * Automatic routing is calibrated against a Russian taxonomy. Technical names
 * and identifiers may remain Latin, but a token Cyrillic character must not be
 * enough to smuggle an English summary into that embedding space.
 */
export function isRussianSemanticSummary(summary: string): boolean {
  if (typeof summary !== "string" || !summary.trim()) {
    return false;
  }
  let letters = 0;
  let cyrillic = 0;
  for (const char of summary.normalize("NFC")) {
    if (/\p{L}/u.test(char)) {
      letters += 1;
      if (/[А-Яа-яЁё]/u.test(char)) {
        cyrillic += 1;
      }
    }
  }
  return cyrillic >= 4 && letters > 0 && cyrillic / letters >= 0.25;
}

export function registerOpenVikingImportTools(deps: OpenVikingImportToolsDeps): void {
  if (deps.enableAddResourceTool) {
    deps.registerTool(
      (ctx: OpenVikingImportToolContext) => ({
        name: "add_resource",
        label: "Add Resource (OpenViking)",
        description:
          "Use only when the user explicitly asks to import, add, upload, save, or index a document, directory, URL, Git repository, or OpenClaw media attachment into OpenViking resources. " +
          "Never use this during search, retrieval, URI reading, or search-result optimization; use ov_search and ov_read for those flows. " +
          "For a '[media attached: /path ...]' document, set source to that exact local media path. Do not invent OpenViking upload REST endpoints. " +
          "When automatic resource routing is enabled and category is omitted, you MUST provide summary in Russian: one short sentence describing the actual semantic content and purpose of the resource. Write the summary in Russian even when the source material is in another language; preserve product names, commands, code identifiers, protocols, and other technical terms when useful. Inspect or read enough of the resource to understand it unless its contents are already established in the conversation; never guess from its filename or path. " +
          "Use category only as an explicit override with an existing full taxonomy path such as code/source/javascript, or a stable semantic key for compatibility. Never invent category paths, keys, or resource URIs. Unknown, ambiguous, or organizational category selectors are routed to the configured fallback inbox rather than creating new paths. " +
          "The agent-facing tool deliberately does not expose arbitrary target URIs, extraction instructions, parser controls, or watch settings. This tool always submits imports asynchronously and returns after OpenViking accepts the job. Never retry the same import automatically after an outcome-unknown transport failure; inspect OpenViking state first.",
        parameters: Type.Object({
          source: Type.String({
            description: "Local path, OpenClaw media attachment path, directory path, public URL, or Git URL",
          }),
          summary: Type.Optional(Type.String({
            description: "Required for automatic routing: one short Russian sentence based on known or inspected content, describing what the resource is about and what it is useful for. Technical product names, commands, protocols and code identifiers may remain in their natural form.",
          })),
          category: Type.Optional(Type.String({
            description: "Optional explicit override using an existing full taxonomy path such as code/source/javascript. A stable semantic key is also accepted for compatibility. The plugin resolves the selector to a trusted URI; never invent a path/key or provide an arbitrary URI.",
          })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          if (deps.isBypassedSession(ctx)) {
            return deps.makeBypassedToolResult("add_resource");
          }

          const source = typeof params.source === "string" ? params.source.trim() : "";
          if (!source) {
            return rejectedResourceImport("add_resource requires a non-empty source.");
          }
          const explicitCategory = typeof params.category === "string" && params.category.trim()
            ? params.category.trim()
            : undefined;

          const session = deps.resolvePluginSessionRouting(ctx);
          let targetParent: string | undefined;
          let createParent: boolean | undefined;
          let routingDetails: Record<string, unknown> = {
            mode: deps.resourceRouting?.enabled ? "automatic" : "legacy_default",
          };

          if (explicitCategory) {
            if (!deps.resourceRouting?.enabled) {
              return rejectedResourceImport(
                "Semantic category routing is disabled. Enable resourceRouting before using a category override.",
                { category: explicitCategory },
              );
            }
            const resolved = deps.resourceRouting.resolveCategoryOrFallback(
              session.agentId,
              explicitCategory,
            );
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
          } else if (deps.resourceRouting?.enabled) {
            const summary = typeof params.summary === "string" ? params.summary.trim() : "";
            if (!summary) {
              return rejectedResourceImport(
                "Automatic resource routing requires `summary`. Inspect or read enough of the resource to understand its actual content, then describe in one short Russian sentence what it is about and what it is useful for. Do not guess from or merely repeat its filename, path, MIME type, or storage location.",
                { routing: "automatic", source },
              );
            }
            if (!isRussianSemanticSummary(summary)) {
              return rejectedResourceImport(
                "Automatic resource routing requires a genuinely Russian semantic `summary`, not an English sentence with a token Cyrillic character. Rewrite the content-and-purpose summary in Russian; technical product names, commands, protocols and code identifiers may remain in their original form.",
                { routing: "automatic", source, summaryLanguage: "ru" },
              );
            }
            const metadata = inferResourceSourceMetadata(source);
            try {
              const routed = await deps.resourceRouting.routeAutomatic({
                agentId: session.agentId,
                source,
                sourceKind: metadata.sourceKind,
                filename: metadata.filename,
                extension: metadata.extension,
                summary,
              });
              targetParent = routed.category.uri;
              createParent = true;
              routingDetails = {
                mode: "automatic",
                category: routed.category.key,
                categoryPath: routed.category.path,
                parent: routed.category.uri,
                fallback: routed.decision.fallback,
                fallbackReason: routed.decision.fallbackReason,
                rerankerUsed: routed.decision.rerankerUsed,
                embeddingCandidates: routed.decision.embeddingCandidates.map(({ key, path, score }) => ({
                  key,
                  path,
                  score,
                })),
              };
            } catch (error) {
              return {
                content: [{
                  type: "text" as const,
                  text:
                    `OpenViking resource routing failed; the resource was NOT imported. ${error instanceof Error ? error.message : String(error)} ` +
                    "Check the configured taxonomy and local embedding/reranker services, then retry.",
                }],
                details: {
                  action: "routing_failed",
                  source,
                  error: error instanceof Error ? error.message : String(error),
                },
              };
            }
          }

          const client = await deps.getClient(session.agentId);
          let result: AsyncAddResourceResult;
          try {
            result = await client.addResource({
              pathOrUrl: source,
              parent: targetParent,
              createParent,
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
          };
        },
      }),
      { name: "add_resource" },
    );
  }

  if (deps.enableRemoveResourceTool) {
    deps.registerTool(
      (ctx: OpenVikingImportToolContext) => ({
        name: "remove_resource",
        label: "Remove Resource (OpenViking)",
        description:
          "Use when the user explicitly asks to delete or remove content from OpenViking resources. " +
          "This tool is restricted to descendants of viking://resources/ and must never be used for memories, sessions, skills, or other namespaces. " +
          "To clear all resources, first use ov_list on viking://resources, then remove each top-level child; the viking://resources root itself cannot be deleted. " +
          "Set recursive=true for a non-empty resource directory. The resource deletion itself is submitted without waiting for semantic refresh; OpenViking may continue semantic/index consistency work asynchronously. " +
          "If the transport outcome is unknown, inspect the URI before any deliberate retry. A NOT_FOUND response is treated as already absent.",
        parameters: Type.Object({
          uri: Type.String({
            description: "Exact resource URI below viking://resources/, for example viking://resources/project-docs or viking://resources/project-docs/file.pdf. The viking://resources root itself is not allowed.",
          }),
          recursive: Type.Optional(Type.Boolean({
            description: "Remove the entire subtree below uri. Required for non-empty resource directories; default false.",
          })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          if (deps.isBypassedSession(ctx)) {
            return deps.makeBypassedToolResult("remove_resource");
          }
          const requestedUri = typeof params.uri === "string" ? params.uri : "";
          const validation = validateRemovableResourceUri(requestedUri);
          if (!validation.ok) {
            return {
              content: [{ type: "text" as const, text: validation.reason }],
              details: { action: "rejected", uri: requestedUri || undefined },
            };
          }

          const session = deps.resolvePluginSessionRouting(ctx);
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
                  text: "OpenViking resource is already absent: " + validation.uri + ".",
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
                  "OpenViking removal outcome is unknown for " + validation.uri + " because the transport failed without an HTTP response. Do not repeat the delete automatically. Inspect the URI first; retry only if it is still present.",
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
          };
        },
      }),
      { name: "remove_resource" },
    );
  }

  deps.registerTool(
    (ctx: OpenVikingImportToolContext) => ({
      name: "add_skill",
      label: "Add Skill (OpenViking)",
      description:
        "Use only when the user explicitly asks to import, add, install, or register a skill into OpenViking. " +
        "Set source to a local SKILL.md file or skill directory, or data to raw SKILL.md content or an MCP tool dict. " +
        "This agent tool always submits the import asynchronously. Never retry the same skill import automatically after an outcome-unknown transport failure; inspect OpenViking state first.",
      parameters: Type.Object({
        source: Type.Optional(Type.String({ description: "Local SKILL.md path or skill directory path" })),
        data: Type.Optional(Type.Any({ description: "Raw SKILL.md content or MCP tool dict" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        if (deps.isBypassedSession(ctx)) {
          return deps.makeBypassedToolResult("add_skill");
        }
        const session = deps.resolvePluginSessionRouting(ctx);
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
        };
      },
    }),
    { name: "add_skill" },
  );
}
