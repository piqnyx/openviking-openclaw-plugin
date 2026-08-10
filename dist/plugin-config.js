import { memoryOpenVikingConfigSchema, } from "./config.js";
import { parseResourceRoutingConfig, } from "./routing/resource-routing-config.js";
export const openVikingPluginConfigSchema = {
    parse(value) {
        const raw = value && typeof value === "object" && !Array.isArray(value)
            ? value
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
