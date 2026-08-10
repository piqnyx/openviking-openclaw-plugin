import { readFile, writeFile } from "node:fs/promises";

async function replaceOnce(path, before, after) {
  const text = await readFile(path, "utf8");
  const first = text.indexOf(before);
  if (first < 0) {
    throw new Error(`${path}: integration anchor not found:\n${before}`);
  }
  if (text.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${path}: integration anchor is not unique:\n${before}`);
  }
  await writeFile(path, text.slice(0, first) + after + text.slice(first + before.length), "utf8");
}

await replaceOnce(
  "client.ts",
  "  to?: string;\n  parent?: string;\n  reason?: string;",
  "  to?: string;\n  parent?: string;\n  createParent?: boolean;\n  reason?: string;",
);

await replaceOnce(
  "client.ts",
  "    if (input.to && input.parent) {\n      throw new Error(\"Cannot specify both 'to' and 'parent'.\");\n    }\n\n    const body: Record<string, unknown> = {\n      to: input.to,\n      parent: input.parent,",
  "    if (input.to && input.parent) {\n      throw new Error(\"Cannot specify both 'to' and 'parent'.\");\n    }\n    if (input.createParent === true && !input.parent) {\n      throw new Error(\"'createParent' requires 'parent'.\");\n    }\n\n    const body: Record<string, unknown> = {\n      to: input.to,\n      parent: input.parent,\n      create_parent: input.createParent,",
);

await replaceOnce(
  "plugin/openviking-import-tools.ts",
  '  AddSkillResult,\n} from "../client.js";\n',
  '  AddSkillResult,\n} from "../client.js";\nimport {\n  AddResourceRoutingError,\n  planAddResourceRouting,\n  type AddResourceRoutingManager,\n} from "../resource-routing/add-resource-plan.js";\n',
);

await replaceOnce(
  "plugin/openviking-import-tools.ts",
  "  enableAddResourceTool: boolean;\n  enableRemoveResourceTool: boolean;\n};",
  "  enableAddResourceTool: boolean;\n  enableRemoveResourceTool: boolean;\n  resourceRoutingManager?: AddResourceRoutingManager;\n};",
);

await replaceOnce(
  "plugin/openviking-import-tools.ts",
  '        description:\n          "Use only when the user explicitly asks to import, add, upload, save, or index a document, directory, URL, Git repository, or OpenClaw media attachment into OpenViking resources. " +\n          "Never use this during search, retrieval, URI reading, or search-result optimization; use ov_search and ov_read for those flows. " +\n          "For a \'[media attached: /path ...]\' document, set source to that exact local media path. Do not invent OpenViking upload REST endpoints.",',
  '        description:\n          "Use only when the user explicitly asks to import, add, upload, save, or index a document, directory, URL, Git repository, or OpenClaw media attachment into OpenViking resources. " +\n          "Never use this during search, retrieval, URI reading, or search-result optimization; use ov_search and ov_read for those flows. " +\n          "For automatic resource routing, always provide summary as one short sentence describing the resource semantic content and purpose; do not merely repeat its filename, path, MIME type, or storage location. " +\n          "Explicit to or parent overrides all routing. Explicit category selects an existing configured taxonomy category without semantic classification. Do not invent category names or viking:// URIs. " +\n          "For a \'[media attached: /path ...]\' document, set source to that exact local media path. Do not invent OpenViking upload REST endpoints.",',
);

await replaceOnce(
  "plugin/openviking-import-tools.ts",
  '          parent: Type.Optional(Type.String({ description: "Parent URI under viking://resources" })),\n          reason: Type.Optional(Type.String({ description: "Reason or note for adding this resource" })),',
  '          parent: Type.Optional(Type.String({ description: "Parent URI under viking://resources. Overrides category and automatic routing." })),\n          category: Type.Optional(Type.String({ description: "Existing semantic category key from the configured per-agent resource taxonomy. Do not invent category names." })),\n          summary: Type.Optional(Type.String({ description: "One short sentence describing semantic content and purpose. Required only for automatic routing when no to, parent, or category is supplied." })),\n          create_parent: Type.Optional(Type.Boolean({ description: "Create an explicitly supplied parent path when missing. Automatic/category routing sets this true itself." })),\n          reason: Type.Optional(Type.String({ description: "Reason or note for adding this resource" })),',
);

await replaceOnce(
  "plugin/openviking-import-tools.ts",
  '          const session = deps.resolvePluginSessionRouting(ctx);\n          const client = await deps.getClient(session.agentId);\n          const result = await client.addResource({\n            pathOrUrl: typeof params.source === "string" ? params.source : "",\n            to: typeof params.to === "string" ? params.to : undefined,\n            parent: typeof params.parent === "string" ? params.parent : undefined,\n            reason: typeof params.reason === "string" ? params.reason : undefined,\n            instruction: typeof params.instruction === "string" ? params.instruction : undefined,\n            wait: typeof params.wait === "boolean" ? params.wait : undefined,\n            timeout: typeof params.timeout === "number" ? params.timeout : undefined,\n          }, session.actorPeerId);\n          return {\n            content: [{ type: "text" as const, text: formatResourceImportText(result) }],\n            details: {\n              action: "resource_imported",\n              ...result,\n            },\n          };',
  '          const session = deps.resolvePluginSessionRouting(ctx);\n          let plan;\n          try {\n            plan = await planAddResourceRouting({\n              agentId: session.agentId,\n              manager: deps.resourceRoutingManager,\n              params: {\n                source: typeof params.source === "string" ? params.source : "",\n                to: typeof params.to === "string" ? params.to : undefined,\n                parent: typeof params.parent === "string" ? params.parent : undefined,\n                category: typeof params.category === "string" ? params.category : undefined,\n                summary: typeof params.summary === "string" ? params.summary : undefined,\n                createParent: typeof params.create_parent === "boolean" ? params.create_parent : undefined,\n                reason: typeof params.reason === "string" ? params.reason : undefined,\n                instruction: typeof params.instruction === "string" ? params.instruction : undefined,\n                wait: typeof params.wait === "boolean" ? params.wait : undefined,\n                timeout: typeof params.timeout === "number" ? params.timeout : undefined,\n              },\n            });\n          } catch (error) {\n            if (error instanceof AddResourceRoutingError) {\n              return {\n                content: [{ type: "text" as const, text: error.message }],\n                details: {\n                  action: error.code === "routing_infrastructure_error" ? "resource_routing_failed" : "resource_routing_rejected",\n                  code: error.code,\n                },\n              };\n            }\n            throw error;\n          }\n\n          const client = await deps.getClient(session.agentId);\n          const result = await client.addResource(plan.input, session.actorPeerId);\n          return {\n            content: [{ type: "text" as const, text: formatResourceImportText(result) }],\n            details: {\n              action: "resource_imported",\n              routing: plan.details,\n              ...result,\n            },\n          };',
);

await replaceOnce(
  "index.ts",
  'import { memoryOpenVikingConfigSchema } from "./config.js";\n',
  'import { memoryOpenVikingConfigSchema } from "./config.js";\nimport { ResourceRoutingManager } from "./resource-routing/manager.js";\n',
);

await replaceOnce(
  "index.ts",
  '    if (cfg.peer_role !== "none") {',
  '    const resourceRoutingManager = new ResourceRoutingManager(cfg.resourceRouting, api.logger);\n\n    if (cfg.peer_role !== "none") {',
);

await replaceOnce(
  "index.ts",
  '      enableAddResourceTool: cfg.enableAddResourceTool,\n      enableRemoveResourceTool: cfg.enableRemoveResourceTool,\n    });',
  '      enableAddResourceTool: cfg.enableAddResourceTool,\n      enableRemoveResourceTool: cfg.enableRemoveResourceTool,\n      resourceRoutingManager,\n    });',
);

await replaceOnce(
  "index.ts",
  '    registerSetupCli(api);\n    const recallTraceHttpRoutesRegistered = registerRecallTraceRoutes(api);\n\n    api.registerService(createOpenVikingService({',
  '    registerSetupCli(api);\n    const recallTraceHttpRoutesRegistered = registerRecallTraceRoutes(api);\n\n    if (cfg.resourceRouting.enabled) {\n      api.registerService({\n        id: "openviking-resource-routing",\n        start: async () => {\n          await resourceRoutingManager.initializeKnownAgents(agentKeys.agentNames);\n        },\n      });\n    }\n\n    api.registerService(createOpenVikingService({',
);
