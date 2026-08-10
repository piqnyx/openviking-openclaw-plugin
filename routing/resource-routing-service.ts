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
  loadResourceTaxonomyFile,
  resolvePerAgentFileTemplate,
  type CompiledResourceCategory,
  type CompiledResourceTaxonomy,
} from "./resource-taxonomy.js";

export type ResourceRoutingServiceOptions = {
  embeddingTransport?: HttpTransport;
  rerankerTransport?: HttpTransport;
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

export class ResourceRoutingService {
  readonly #config: ParsedResourceRoutingConfig;
  readonly #embeddingTransport?: HttpTransport;
  readonly #rerankerTransport?: HttpTransport;
  readonly #taxonomies = new Map<string, CompiledResourceTaxonomy>();
  readonly #routerPromises = new Map<string, Promise<ResourceRouter>>();

  constructor(config: ParsedResourceRoutingConfig, options: ResourceRoutingServiceOptions = {}) {
    this.#config = config;
    this.#embeddingTransport = options.embeddingTransport;
    this.#rerankerTransport = options.rerankerTransport;
  }

  get enabled(): boolean {
    return this.#config.enabled;
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

  resolveCategory(agentId: string, categoryKey: string): CompiledResourceCategory {
    if (!this.#config.enabled) {
      throw new Error("resource routing is disabled; semantic category routing is unavailable");
    }
    if (typeof categoryKey !== "string" || !categoryKey.trim()) {
      throw new Error("resource routing category key must be a non-empty string");
    }
    const taxonomy = this.#getTaxonomy(agentId);
    const category = taxonomy.byKey.get(categoryKey.trim());
    if (!category) {
      throw new Error(
        `Unknown resource category ${JSON.stringify(categoryKey.trim())}. Use a semantic key that exists in this agent's taxonomy.`,
      );
    }
    if (!category.routeable) {
      throw new Error(
        `Resource category ${JSON.stringify(category.key)} is organizational only and cannot receive resources directly.`,
      );
    }
    return category;
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

  async routeAutomatic(input: AutomaticResourceRouteInput): Promise<AutomaticResourceRouteResult> {
    if (!this.#config.enabled) {
      throw new Error("resource routing is disabled; automatic routing is unavailable");
    }
    const taxonomy = this.#getTaxonomy(input.agentId);
    const semanticInput = renderResourceRoutingSemanticInput(this.#config.semanticInputTemplate, input);
    const auditFile = resolvePerAgentFileTemplate(this.#config.audit.file, input.agentId);
    const started = performance.now();
    try {
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
          timing: { totalMs: performance.now() - started },
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
