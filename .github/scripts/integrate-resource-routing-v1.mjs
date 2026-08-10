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
  "config.ts",
  'import { getEnv } from "./runtime-utils.js";\n',
  'import { getEnv } from "./runtime-utils.js";\nimport {\n  parseResourceRoutingConfig,\n  type ParsedResourceRoutingConfig,\n  type ResourceRoutingConfigInput,\n} from "./resource-routing/config.js";\n',
);

await replaceOnce(
  "config.ts",
  '  /** Optional JSON file path for runtime query config overrides. Empty means in-memory only. */\n  runtimeQueryConfigPath?: string;\n  agentExperience?: {',
  '  /** Optional JSON file path for runtime query config overrides. Empty means in-memory only. */\n  runtimeQueryConfigPath?: string;\n  /** Optional semantic router for automatically placing imported resources into per-agent taxonomy branches. */\n  resourceRouting?: ResourceRoutingConfigInput;\n  agentExperience?: {',
);

await replaceOnce(
  "config.ts",
  'export type ParsedMemoryOpenVikingConfig = Required<\n  Omit<MemoryOpenVikingConfig, "agentExperience" | "recallTargetTypes">\n> & {\n  agentExperience: Required<NonNullable<MemoryOpenVikingConfig["agentExperience"]>>;\n  recallTargetTypes: Array<"resource" | "user" | "agent">;\n};',
  'export type ParsedMemoryOpenVikingConfig = Required<\n  Omit<MemoryOpenVikingConfig, "agentExperience" | "recallTargetTypes" | "resourceRouting">\n> & {\n  agentExperience: Required<NonNullable<MemoryOpenVikingConfig["agentExperience"]>>;\n  recallTargetTypes: Array<"resource" | "user" | "agent">;\n  resourceRouting: ParsedResourceRoutingConfig;\n};',
);

await replaceOnce(
  "config.ts",
  '        "runtimeQueryConfigPath",\n        "agentExperience",',
  '        "runtimeQueryConfigPath",\n        "resourceRouting",\n        "agentExperience",',
);

await replaceOnce(
  "config.ts",
  '    const { enabledTools, disabledTools } = normalizeEnabledTools(cfg);\n\n    return {',
  '    const { enabledTools, disabledTools } = normalizeEnabledTools(cfg);\n    const resourceRouting = parseResourceRoutingConfig(cfg.resourceRouting);\n\n    return {',
);

await replaceOnce(
  "config.ts",
  '      runtimeQueryConfigPath:\n        typeof cfg.runtimeQueryConfigPath === "string" && cfg.runtimeQueryConfigPath.trim()\n          ? expandHomeDir(cfg.runtimeQueryConfigPath.trim())\n          : "",\n      agentExperience: {',
  '      runtimeQueryConfigPath:\n        typeof cfg.runtimeQueryConfigPath === "string" && cfg.runtimeQueryConfigPath.trim()\n          ? expandHomeDir(cfg.runtimeQueryConfigPath.trim())\n          : "",\n      resourceRouting,\n      agentExperience: {',
);

await replaceOnce(
  "config.ts",
  '    enableAddResourceTool: {\n      label: "Enable Add Resource Tool",',
  '    resourceRouting: {\n      label: "Resource Routing",\n      help: "Optional per-agent semantic routing for add_resource. Uses a YAML taxonomy and configured embedding/reranker endpoints; infrastructure failures fail closed.",\n      advanced: true,\n    },\n    enableAddResourceTool: {\n      label: "Enable Add Resource Tool",',
);

await replaceOnce(
  "resource-routing/default-taxonomy.yaml",
  "schemaVersion: 1\nfallback: inbox\n\ncategories:\n",
  "schemaVersion: 1\n\ncategories:\n",
);

const pluginManifestPath = "openclaw.plugin.json";
const pluginManifest = JSON.parse(await readFile(pluginManifestPath, "utf8"));
pluginManifest.uiHints ??= {};
pluginManifest.uiHints.resourceRouting = {
  label: "Resource Routing",
  help: "Per-agent YAML taxonomy with embedding + conditional reranker routing for add_resource.",
  advanced: true,
};
pluginManifest.configSchema.properties.resourceRouting = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean", default: false },
    taxonomyFile: { type: "string", description: "Per-agent YAML taxonomy path template. Must contain {agentId}." },
    cacheFile: { type: "string", description: "Per-agent category embedding cache path template. Must contain {agentId}." },
    auditFile: { type: "string", description: "Per-agent routing audit JSONL path template. Must contain {agentId}." },
    semanticInputTemplate: { type: "string", description: "Semantic routing input template. Must contain {{summary}}." },
    fallbackCategory: { type: "string", description: "Semantic category key used when classification is uncertain." },
    failurePolicy: { type: "string", enum: ["error"], default: "error" },
    embedding: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseUrl: { type: "string" },
        endpointPath: { type: "string" },
        apiKey: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        model: { type: "string" },
        timeoutMs: { type: "number", minimum: 100, maximum: 300000 },
        dimensions: { type: "number", minimum: 1, maximum: 65536 },
      },
    },
    reranker: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseUrl: { type: "string" },
        endpointPath: { type: "string" },
        apiKey: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        model: { type: "string" },
        timeoutMs: { type: "number", minimum: 100, maximum: 300000 },
      },
    },
    retrieval: {
      type: "object",
      additionalProperties: false,
      properties: {
        topK: { type: "number", minimum: 1, maximum: 50 },
        minScore: { type: "number", minimum: -1, maximum: 1 },
        rerankBelowMargin: { type: "number", minimum: 0, maximum: 2 },
      },
    },
    audit: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        includeSummaryPreview: { type: "boolean" },
        summaryPreviewChars: { type: "number", minimum: 20, maximum: 4000 },
      },
    },
  },
};
await writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`, "utf8");

const installManifestPath = "install-manifest.json";
const installManifest = JSON.parse(await readFile(installManifestPath, "utf8"));
if (!installManifest.files.required.includes("resource-routing/")) {
  const index = installManifest.files.required.indexOf("routing/");
  if (index < 0) {
    throw new Error("install-manifest.json: routing/ anchor missing");
  }
  installManifest.files.required.splice(index, 0, "resource-routing/");
}
await writeFile(installManifestPath, `${JSON.stringify(installManifest, null, 2)}\n`, "utf8");
