import {
  memoryOpenVikingConfigSchema,
  type ParsedMemoryOpenVikingConfig,
} from "./config.js";
import {
  parseResourceRoutingConfig,
  type ParsedResourceRoutingConfig,
} from "./routing/resource-routing-config.js";

export type ParsedOpenVikingPluginConfig = ParsedMemoryOpenVikingConfig & {
  resourceRouting: ParsedResourceRoutingConfig;
};

export const openVikingPluginConfigSchema = {
  parse(value: unknown): ParsedOpenVikingPluginConfig {
    const raw = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const baseRaw = { ...raw };
    const resourceRoutingRaw = baseRaw.resourceRouting;
    delete baseRaw.resourceRouting;

    return {
      ...memoryOpenVikingConfigSchema.parse(baseRaw),
      resourceRouting: parseResourceRoutingConfig(resourceRoutingRaw),
    };
  },
  uiHints: memoryOpenVikingConfigSchema.uiHints,
};
