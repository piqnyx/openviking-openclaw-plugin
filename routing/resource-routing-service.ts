import { performance } from "node:perf_hooks";

import type { HttpTransport } from "../adapters/http-transport.js";
import { writeResourceRoutingAudit } from "./resource-routing-audit.js";
import type { ParsedResourceRoutingConfig } from "./resource-routing-config.js";
import {
  ResourceRoutingEmbeddingClient,
  ResourceRoutingRerankerClient,
} from "./resource-routing-model-client.js";
import { renderResourceRoutingSemanticInput, type ResourceRoutingSemanticContext } from "./resource-routing-semantic-input.js";
import {
  buildResourceRoutingEmbeddingState,
  ResourceRouter,
  type ResourceRoutingDecision,
} from "./resource-router.js";
import {
  RESOURCE_TAXONOMY_ROOT_URI,
  loadResourceTaxonomyFile,
  resolvePerAgentFileTemplate,
  type CompiledResourceCategory,
  type CompiledResourceTaxonomy,
} from "./resource-taxonomy.js";

export type ResourceRoutingServiceOptions = {
  embeddingTransport?: HttpTransport;
  rerankerTransport?: HttpTransport;
};

export type ResourceRoutingPreloadLogger = {
  info: (message: string) => void;
  warn?: (message: string) => void;
  error: (message: string) => void;
};

export type ResourceRoutingPreloadResult = {
  ready: string[];
  failed: Array<{ agentId: string; error: string }>;
};

export type AutomaticResourceRouteInput = ResourceRoutingSemanticContext & {
  agentId: string;
  source: string;
  sourceKind?: string;
};

export type AutomaticResourceRouteResult = {
  category: CompiledResourceCategory;
  decision: ResourceRoutingDecision;
  semanticInput: string;
};

export type ExplicitResourceCategoryResolution = {
  requested: string;
  category: CompiledResourceCategory;
  matchedBy: "key" | "path" | "fallback";
  fallback: boolean;
  fallbackReason?: "unknown_category" | "organizational_category" | "ambiguous_category";
};

function normalizeCategoryPathSelector(selector: string): string {
  const uriPrefix = `${RESOURCE_TAXONOMY_ROOT_URI}/`;
  let normalized = selector.trim();
  if (normalized.startsWith(uriPrefix)) {
    normalized = normalized.slice(uriPrefix.length);
  }
  return normalized.replace(/^\/+|\/+$/g, "");
}

function resolveSelector(
  taxonomy: CompiledResourceTaxonomy,
  selector: string,
): { category?: CompiledResourceCategory; matchedBy?: "key" | "path"; ambiguous: boolean } {
  const trimmed = selector.trim();
  const path = normalizeCategoryPathSelector(trimmed);
  const explicitPath = trimmed.includes("/") || trimmed.startsWith(`${RESOURCE_TAXONOMY_ROOT_URI}/`);

  if (explicitPath) {
    return {
      category: path ? taxonomy.byPath.get(path) : undefined,
      matchedBy: path && taxonomy.byPath.has(path) ? "path" : undefined,
      ambiguous: false,
    };
  }

  const keyMatch = taxonomy.byKey.get(trimmed);
  const pathMatch = path ? taxonomy.byPath.get(path) : undefined;
  if (keyMatch && pathMatch && keyMatch.key !== pathMatch.key) {
    return { ambiguous: true };
  }
  if (keyMatch) {
    return { category: keyMatch, matchedBy: "key", ambiguous: false };
  }
  if (pathMatch) {
    return { category: pathMatch, matchedBy: "path", ambiguous: false };
  }
  return { ambiguous: false };
}

export class ResourceRoutingService {
  readonly #config: ParsedResourceRoutingConfig;
  readonly #embeddingTransport?: HttpTransport;
  readonly #rerankerTransport?: HttpTransport;
  readonly #taxonomies = new Map<string, CompiledResourceTaxonomy>();
  readonly #routerPromises = new Map<string, Promise<ResourceRouter>>();
  #preloadPromise?: Promise<ResourceRoutingPreloadResult>;

  constructor(config: ParsedResourceRoutingConfig, options: ResourceRoutingServiceOptions = {}) {
    this.#config = config;
    this.#embeddingTransport = options.embeddingTransport;
    this.#rerankerTransport = options.rerankerTransport;
  }

  get enabled(): boolean {
    return this.#config.enabled;
  }

  get summaryLanguage(): ParsedResourceRoutingConfig["summaryLanguage"] {
    return this.#config.summaryLanguage;
  }

  #getTaxonomy(agentId: string): CompiledResourceTaxonomy {
    const cached = this.#taxonomies.get(agentId);
    if (cached) {
      return cached;
    }
    const taxonomyFile = resolvePerAgentFileTemplate(this.#config.taxonomyFile, agentId);
    const taxonomy = loadResourceTaxonomyFile(taxonomyFile);
    if (taxonomy.fallbackKey !== this.#config.fallbackCategory) {
      throw new Error(
        `resource routing fallback mismatch for agent ${JSON.stringify(agentId)}: config selects ${JSON.stringify(this.#config.fallbackCategory)} but taxonomy declares ${JSON.stringify(taxonomy.fallbackKey)}`,
      );
    }
    this.#taxonomies.set(agentId, taxonomy);
    return taxonomy;
  }

  #fallbackCategory(taxonomy: CompiledResourceTaxonomy): CompiledResourceCategory {
    const fallback = taxonomy.byKey.get(this.#config.fallbackCategory);
    if (!fallback || !fallback.routeable) {
      throw new Error(
        `resource routing fallback category ${JSON.stringify(this.#config.fallbackCategory)} is missing or not routeable`,
      );
    }
    return fallback;
  }

  resolveCategory(agentId: string, selector: string): CompiledResourceCategory {
    if (!this.#config.enabled) {
      throw new Error("resource routing is disabled; semantic category routing is unavailable");
    }
    if (typeof selector !== "string" || !selector.trim()) {
      throw new Error("resource routing category selector must be a non-empty string");
    }
    const taxonomy = this.#getTaxonomy(agentId);
    const resolved = resolveSelector(taxonomy, selector);
    if (resolved.ambiguous) {
      throw new Error(
        `Resource category selector ${JSON.stringify(selector.trim())} is ambiguous between a semantic key and a taxonomy path. Use the full taxonomy path.`,
      );
    }
    const category = resolved.category;
    if (!category) {
      throw new Error(
        `Unknown resource category ${JSON.stringify(selector.trim())}. Use an existing semantic key or taxonomy path such as code/source/javascript.`,
      );
    }
    if (!category.routeable) {
      throw new Error(
        `Resource category ${JSON.stringify(category.path)} is organizational only and cannot receive resources directly.`,
      );
    }
    return category;
  }

  resolveCategoryOrFallback(agentId: string, selector: string): ExplicitResourceCategoryResolution {
    if (!this.#config.enabled) {
      throw new Error("resource routing is disabled; semantic category routing is unavailable");
    }
    if (typeof selector !== "string" || !selector.trim()) {
      throw new Error("resource routing category selector must be a non-empty string");
    }
    const requested = selector.trim();
    const taxonomy = this.#getTaxonomy(agentId);
    const resolved = resolveSelector(taxonomy, requested);
    if (resolved.ambiguous) {
      return {
        requested,
        category: this.#fallbackCategory(taxonomy),
        matchedBy: "fallback",
        fallback: true,
        fallbackReason: "ambiguous_category",
      };
    }
    if (!resolved.category) {
      return {
        requested,
        category: this.#fallbackCategory(taxonomy),
        matchedBy: "fallback",
        fallback: true,
        fallbackReason: "unknown_category",
      };
    }
    if (!resolved.category.routeable) {
      return {
        requested,
        category: this.#fallbackCategory(taxonomy),
        matchedBy: "fallback",
        fallback: true,
        fallbackReason: "organizational_category",
      };
    }
    return {
      requested,
      category: resolved.category,
      matchedBy: resolved.matchedBy ?? "key",
      fallback: false,
    };
  }

  async #getRouter(agentId: string): Promise<ResourceRouter> {
    const existing = this.#routerPromises.get(agentId);
    if (existing) {
      return existing;
    }
    const promise = (async () => {
      const taxonomy = this.#getTaxonomy(agentId);
      const embedder = new ResourceRoutingEmbeddingClient(
        this.#config.embedding,
        { transport: this.#embeddingTransport },
      );
      const reranker = new ResourceRoutingRerankerClient(
        this.#config.reranker,
        { transport: this.#rerankerTransport },
      );
      const embeddings = await buildResourceRoutingEmbeddingState({
        taxonomy,
        agentId,
        config: this.#config,
        embedder,
      });
      return new ResourceRouter({
        taxonomy,
        config: this.#config,
        embeddings,
        embedder,
        reranker,
      });
    })();
    this.#routerPromises.set(agentId, promise);
    try {
      return await promise;
    } catch (error) {
      this.#routerPromises.delete(agentId);
      throw error;
    }
  }

  async initializeAgent(agentId: string): Promise<void> {
    if (!this.#config.enabled) {
      return;
    }
    await this.#getRouter(agentId);
  }

  async preloadAgents(
    agentIds: readonly string[],
    logger: ResourceRoutingPreloadLogger,
  ): Promise<ResourceRoutingPreloadResult> {
    if (!this.#config.enabled) {
      return { ready: [], failed: [] };
    }
    const existing = this.#preloadPromise;
    if (existing) {
      return existing;
    }

    const promise = (async (): Promise<ResourceRoutingPreloadResult> => {
      const ready: string[] = [];
      const failed: Array<{ agentId: string; error: string }> = [];
      const uniqueAgentIds = [...new Set(agentIds.map((agentId) => agentId.trim()).filter(Boolean))].sort();
      for (const agentId of uniqueAgentIds) {
        try {
          await this.initializeAgent(agentId);
          ready.push(agentId);
          logger.info(`openviking: resource routing ready for agent ${agentId}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failed.push({ agentId, error: message });
          logger.error(
            `openviking: resource routing preload failed for agent ${agentId}: ${message}. ` +
            "Automatic add_resource for this agent remains fail-closed until the taxonomy/config or model service is fixed; restart the gateway after taxonomy/config changes.",
          );
        }
      }
      return { ready, failed };
    })();

    this.#preloadPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.#preloadPromise === promise) {
        this.#preloadPromise = undefined;
      }
    }
  }

  async routeAutomatic(input: AutomaticResourceRouteInput): Promise<AutomaticResourceRouteResult> {
    if (!this.#config.enabled) {
      throw new Error("resource routing is disabled; automatic routing is unavailable");
    }
    const taxonomy = this.#getTaxonomy(input.agentId);
    const semanticInput = renderResourceRoutingSemanticInput(this.#config.semanticInputTemplate, input);
    const auditFile = resolvePerAgentFileTemplate(this.#config.audit.file, input.agentId);
    const started = performance.now();
    try {
      // #getRouter is already deduplicated per agent. Do not wait for a global
      // startup preload covering unrelated agents: an igor cold cache must not
      // block a main routing request, and vice versa.
      const router = await this.#getRouter(input.agentId);
      const decision = await router.route(semanticInput);
      const category = taxonomy.byKey.get(decision.categoryKey);
      if (!category || !category.routeable) {
        throw new Error(`resource routing selected invalid category ${JSON.stringify(decision.categoryKey)}`);
      }
      if (this.#config.audit.enabled) {
        writeResourceRoutingAudit({
          filePath: auditFile,
          agentId: input.agentId,
          source: input.source,
          sourceKind: input.sourceKind,
          summary: input.summary,
          summaryPreviewChars: this.#config.audit.summaryPreviewChars,
          taxonomyHash: taxonomy.taxonomyHash,
          embeddingModel: this.#config.embedding.model,
          rerankerModel: this.#config.reranker.model,
          decision,
          timing: {
            embeddingMs: decision.timing.embeddingMs,
            rerankerMs: decision.timing.rerankerMs,
            totalMs: performance.now() - started,
          },
          status: "success",
        });
      }
      return { category, decision, semanticInput };
    } catch (error) {
      if (this.#config.audit.enabled) {
        try {
          writeResourceRoutingAudit({
            filePath: auditFile,
            agentId: input.agentId,
            source: input.source,
            sourceKind: input.sourceKind,
            summary: input.summary,
            summaryPreviewChars: this.#config.audit.summaryPreviewChars,
            taxonomyHash: taxonomy.taxonomyHash,
            embeddingModel: this.#config.embedding.model,
            rerankerModel: this.#config.reranker.model,
            timing: { totalMs: performance.now() - started },
            status: "error",
            errorCode: "routing_infrastructure_error",
          });
        } catch {
          // Never replace the original routing failure with an audit-write failure.
        }
      }
      throw error;
    }
  }
}
