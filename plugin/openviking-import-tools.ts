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
import {
  AddResourceRoutingError,
  planAddResourceRouting,
  type AddResourceRoutingManager,
} from "../resource-routing/add-resource-plan.js";
import { RESOURCE_ROUTING_MAX_SUMMARY_CHARS } from "../resource-routing/semantic-input.js";

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

export type OpenVikingImportClient = {
  addResource: (input: AddResourceInput, agentId?: string) => Promise<AddResourceResult>;
  removeResource: (input: RemoveResourceInput, agentId?: string) => Promise<RemoveResourceResult>;
  addSkill: (input: AddSkillInput, agentId?: string) => Promise<AddSkillResult>;
};

export type OpenVikingImportToolsDeps = {
  registerTool: (toolOrFactory: unknown, opts: { name: string }) => void;
  getClient: (agentId: string | undefined) => Promise<OpenVikingImportClient>;
  resolvePluginSessionRouting: (ctx?: OpenVikingImportToolContext) => OpenVikingImportSession;
  isBypassedSession: (ctx?: OpenVikingImportToolContext) => boolean;
  makeBypassedToolResult: (toolName: string) => unknown;
  enableAddResourceTool: boolean;
  enableRemoveResourceTool: boolean;
  resourceRoutingManager?: AddResourceRoutingManager;
};

const BASE_ADD_RESOURCE_DESCRIPTION =
  "Use only when the user explicitly asks to import, add, upload, save, or index a document, directory, URL, Git repository, or OpenClaw media attachment into OpenViking resources. " +
  "Never use this during search, retrieval, URI reading, or search-result optimization; use ov_search and ov_read for those flows. " +
  "For a '[media attached: /path ...]' document, set source to that exact local media path. Do not invent OpenViking upload REST endpoints.";

function addResourceDescription(routingEnabled: boolean): string {
  if (!routingEnabled) {
    return BASE_ADD_RESOURCE_DESCRIPTION;
  }
  return (
    "Use only when the user explicitly asks to import, add, upload, save, or index a document, directory, URL, Git repository, or OpenClaw media attachment into OpenViking resources. " +
    "Never use this during search, retrieval, URI reading, or search-result optimization; use ov_search and ov_read for those flows. " +
    "When no explicit destination is supplied, always provide summary as one short sentence describing the resource semantic content and purpose; do not merely repeat its filename, path, MIME type, or storage location. " +
    "Use at most one of to or parent; either explicit target skips category and automatic routing. Explicit category selects an existing configured taxonomy category without semantic classification. Do not invent category names or viking:// URIs. " +
    "For a '[media attached: /path ...]' document, set source to that exact local media path. Do not invent OpenViking upload REST endpoints."
  );
}

function addResourceParameters(routingEnabled: boolean) {
  const common = {
    source: Type.String({ description: "Local path, OpenClaw media attachment path, directory path, public URL, or Git URL" }),
    to: Type.Optional(Type.String({ description: "Exact target URI, e.g. viking://resources/project-docs. Mutually exclusive with parent." })),
    parent: Type.Optional(Type.String({ description: "Parent URI under viking://resources. Mutually exclusive with to." })),
    create_parent: Type.Optional(Type.Boolean({ description: "Create an explicitly supplied parent path when missing." })),
    reason: Type.Optional(Type.String({ description: "Reason or note for adding this resource" })),
    instruction: Type.Optional(Type.String({ description: "Processing instruction for semantic extraction" })),
    wait: Type.Optional(Type.Boolean({ description: "Wait for processing to complete" })),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds when wait is true" })),
  };
  if (!routingEnabled) {
    return Type.Object(common);
  }
  return Type.Object({
    source: common.source,
    to: Type.Optional(Type.String({ description: "Exact target URI. Mutually exclusive with parent; skips category and automatic routing." })),
    parent: Type.Optional(Type.String({ description: "Parent URI under viking://resources. Mutually exclusive with to; skips category and automatic routing." })),
    category: Type.Optional(Type.String({ description: "Existing semantic category key from the configured per-agent resource taxonomy. Do not invent category names." })),
    summary: Type.Optional(Type.String({
      maxLength: RESOURCE_ROUTING_MAX_SUMMARY_CHARS,
      description: "One short sentence describing semantic content and purpose. Required only for automatic routing when no to, parent, or category is supplied.",
    })),
    create_parent: Type.Optional(Type.Boolean({ description: "Create an explicitly supplied parent path when missing. Automatic/category routing sets this true itself." })),
    reason: Type.Optional(Type.String({ description: "OpenViking reason/note for adding this resource. This is not the routing summary." })),
    instruction: common.instruction,
    wait: common.wait,
    timeout: common.timeout,
  });
}

function formatResourceImportText(result: AddResourceResult): string {
  const root = result.root_uri ? ` ${result.root_uri}` : "";
  const warnings = result.warnings?.length ? ` Warnings: ${result.warnings.join("; ")}` : "";
  return `Imported OpenViking resource.${root}${warnings}`.trim();
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
    details.push("semantic refresh queued; consistency work is still pending");
  } else if (result.semantic_status === "failed") {
    details.push("semantic refresh failed after resource removal");
  } else if (result.semantic_status) {
    details.push(`semantic status: ${result.semantic_status}`);
  }
  return `Removed OpenViking resource: ${uri}.${details.length ? ` ${details.join("; ")}.` : ""}`;
}

function formatSkillImportText(result: AddSkillResult): string {
  const uri = result.uri ? ` ${result.uri}` : "";
  const name = result.name ? ` (${result.name})` : "";
  return `Imported OpenViking skill${name}.${uri}`.trim();
}

export function registerOpenVikingImportTools(deps: OpenVikingImportToolsDeps): void {
  if (deps.enableAddResourceTool) {
    const routingEnabled = deps.resourceRoutingManager?.isEnabled() === true;
    deps.registerTool(
      (ctx: OpenVikingImportToolContext) => ({
        name: "add_resource",
        label: "Add Resource (OpenViking)",
        description: addResourceDescription(routingEnabled),
        parameters: addResourceParameters(routingEnabled),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          if (deps.isBypassedSession(ctx)) {
            return deps.makeBypassedToolResult("add_resource");
          }
          const session = deps.resolvePluginSessionRouting(ctx);
          let plan;
          try {
            plan = await planAddResourceRouting({
              agentId: session.agentId,
              manager: deps.resourceRoutingManager,
              params: {
                source: typeof params.source === "string" ? params.source : "",
                to: typeof params.to === "string" ? params.to : undefined,
                parent: typeof params.parent === "string" ? params.parent : undefined,
                category: typeof params.category === "string" ? params.category : undefined,
                summary: typeof params.summary === "string" ? params.summary : undefined,
                createParent: typeof params.create_parent === "boolean" ? params.create_parent : undefined,
                reason: typeof params.reason === "string" ? params.reason : undefined,
                instruction: typeof params.instruction === "string" ? params.instruction : undefined,
                wait: typeof params.wait === "boolean" ? params.wait : undefined,
                timeout: typeof params.timeout === "number" ? params.timeout : undefined,
              },
            });
          } catch (error) {
            if (error instanceof AddResourceRoutingError) {
              return {
                content: [{ type: "text" as const, text: error.message }],
                details: {
                  action: error.code === "routing_infrastructure_error" ? "resource_routing_failed" : "resource_routing_rejected",
                  code: error.code,
                },
              };
            }
            throw error;
          }

          const client = await deps.getClient(session.agentId);
          const result = await client.addResource(plan.input, session.actorPeerId);
          return {
            content: [{ type: "text" as const, text: formatResourceImportText(result) }],
            details: {
              action: "resource_imported",
              ...(routingEnabled ? { routing: plan.details } : {}),
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
          "Set recursive=true for a non-empty resource directory. Set wait=true when subsequent work must wait for OpenViking semantic refresh to finish.",
        parameters: Type.Object({
          uri: Type.String({
            description: "Exact resource URI below viking://resources/, for example viking://resources/project-docs or viking://resources/project-docs/file.pdf. The viking://resources root itself is not allowed.",
          }),
          recursive: Type.Optional(Type.Boolean({
            description: "Remove the entire subtree below uri. Required for non-empty resource directories; default false.",
          })),
          wait: Type.Optional(Type.Boolean({
            description: "Wait for OpenViking semantic refresh associated with the removal to complete. The agent tool defaults to true; set false only when asynchronous cleanup is explicitly desired.",
          })),
          timeout: Type.Optional(Type.Number({
            description: "Server-side wait timeout in seconds when wait=true.",
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
        "Set source to a local SKILL.md file or skill directory, or data to raw SKILL.md content or an MCP tool dict.",
      parameters: Type.Object({
        source: Type.Optional(Type.String({ description: "Local SKILL.md path or skill directory path" })),
        data: Type.Optional(Type.Any({ description: "Raw SKILL.md content or MCP tool dict" })),
        wait: Type.Optional(Type.Boolean({ description: "Wait for processing to complete" })),
        timeout: Type.Optional(Type.Number({ description: "Timeout in seconds when wait is true" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        if (deps.isBypassedSession(ctx)) {
          return deps.makeBypassedToolResult("add_skill");
        }
        const session = deps.resolvePluginSessionRouting(ctx);
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
        };
      },
    }),
    { name: "add_skill" },
  );
}
