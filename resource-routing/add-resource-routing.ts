import type { ParsedResourceRoutingConfig } from "./config.js";
import type { ResourceRoutingTaxonomyLoader } from "./loader.js";
import type {
  ResourceRoutingDecision,
  ResourceRoutingDecisionEngine,
  ResourceRoutingSemanticInput,
} from "./routing.js";
import { resolveResourceTaxonomyCategory } from "./taxonomy.js";

export type AddResourceRoutingInput = ResourceRoutingSemanticInput & {
  agentId: string;
  to?: string;
  parent?: string;
  category?: string;
  createParent?: boolean;
};

export type AddResourceRoutingResolution = {
  to?: string;
  parent?: string;
  createParent?: boolean;
  details: {
    mode: "explicit_to" | "explicit_parent" | "explicit_category" | "automatic" | "legacy_root";
    categoryKey?: string;
    categoryUri?: string;
    decisionReason?: ResourceRoutingDecision["reason"];
    embeddingCandidates?: ResourceRoutingDecision["embeddingCandidates"];
    rerankerUsed?: boolean;
    rerankerCandidates?: ResourceRoutingDecision["rerankerCandidates"];
    fallbackReason?: ResourceRoutingDecision["fallbackReason"];
  };
};

export type AddResourceRoutingResolver = {
  resolve(input: AddResourceRoutingInput): Promise<AddResourceRoutingResolution>;
};

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function createAddResourceRoutingResolver(options: {
  config: ParsedResourceRoutingConfig;
  loader?: ResourceRoutingTaxonomyLoader;
  decisionEngine?: ResourceRoutingDecisionEngine;
}): AddResourceRoutingResolver {
  return {
    async resolve(input: AddResourceRoutingInput): Promise<AddResourceRoutingResolution> {
      const to = trimmed(input.to);
      if (to) {
        return {
          to,
          details: { mode: "explicit_to" },
        };
      }

      const parent = trimmed(input.parent);
      if (parent) {
        return {
          parent,
          createParent: input.createParent,
          details: { mode: "explicit_parent" },
        };
      }

      const categoryKey = trimmed(input.category);
      if (categoryKey) {
        if (!options.config.enabled || !options.loader) {
          throw new Error(
            "Explicit resource `category` requires resourceRouting.enabled=true and a configured per-agent taxonomy. Use `to` or `parent`, or enable resource routing.",
          );
        }
        const loaded = await options.loader.load(input.agentId);
        const category = resolveResourceTaxonomyCategory(
          loaded.taxonomy,
          categoryKey,
          "explicit resource category",
        );
        return {
          parent: category.uri,
          createParent: true,
          details: {
            mode: "explicit_category",
            categoryKey: category.key,
            categoryUri: category.uri,
          },
        };
      }

      if (!options.config.enabled) {
        return {
          details: { mode: "legacy_root" },
        };
      }
      if (!options.decisionEngine) {
        throw new Error("Resource routing is enabled but the automatic routing engine is unavailable");
      }

      let decision: ResourceRoutingDecision;
      try {
        decision = await options.decisionEngine.route(input.agentId, input);
      } catch (err) {
        throw new Error(
          `Automatic resource routing failed; the resource was not imported. ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      return {
        parent: decision.category.uri,
        createParent: true,
        details: {
          mode: "automatic",
          categoryKey: decision.category.key,
          categoryUri: decision.category.uri,
          decisionReason: decision.reason,
          embeddingCandidates: decision.embeddingCandidates,
          rerankerUsed: decision.rerankerUsed,
          rerankerCandidates: decision.rerankerCandidates,
          fallbackReason: decision.fallbackReason,
        },
      };
    },
  };
}
