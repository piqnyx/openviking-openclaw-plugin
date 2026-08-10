import { performance } from "node:perf_hooks";
import { writeResourceRoutingAudit } from "./resource-routing-audit.js";
import { ResourceRoutingEmbeddingClient, ResourceRoutingRerankerClient, } from "./resource-routing-model-client.js";
import { renderResourceRoutingSemanticInput } from "./resource-routing-semantic-input.js";
import { buildResourceRoutingEmbeddingState, ResourceRouter, } from "./resource-router.js";
import { loadResourceTaxonomyFile, resolvePerAgentFileTemplate, } from "./resource-taxonomy.js";
export class ResourceRoutingService {
    #config;
    #embeddingTransport;
    #rerankerTransport;
    #taxonomies = new Map();
    #routerPromises = new Map();
    constructor(config, options = {}) {
        this.#config = config;
        this.#embeddingTransport = options.embeddingTransport;
        this.#rerankerTransport = options.rerankerTransport;
    }
    get enabled() {
        return this.#config.enabled;
    }
    #getTaxonomy(agentId) {
        const cached = this.#taxonomies.get(agentId);
        if (cached) {
            return cached;
        }
        const taxonomyFile = resolvePerAgentFileTemplate(this.#config.taxonomyFile, agentId);
        const taxonomy = loadResourceTaxonomyFile(taxonomyFile);
        if (taxonomy.fallbackKey !== this.#config.fallbackCategory) {
            throw new Error(`resource routing fallback mismatch for agent ${JSON.stringify(agentId)}: config selects ${JSON.stringify(this.#config.fallbackCategory)} but taxonomy declares ${JSON.stringify(taxonomy.fallbackKey)}`);
        }
        this.#taxonomies.set(agentId, taxonomy);
        return taxonomy;
    }
    resolveCategory(agentId, categoryKey) {
        if (!this.#config.enabled) {
            throw new Error("resource routing is disabled; semantic category routing is unavailable");
        }
        if (typeof categoryKey !== "string" || !categoryKey.trim()) {
            throw new Error("resource routing category key must be a non-empty string");
        }
        const taxonomy = this.#getTaxonomy(agentId);
        const category = taxonomy.byKey.get(categoryKey.trim());
        if (!category) {
            throw new Error(`Unknown resource category ${JSON.stringify(categoryKey.trim())}. Use a semantic key that exists in this agent's taxonomy.`);
        }
        if (!category.routeable) {
            throw new Error(`Resource category ${JSON.stringify(category.key)} is organizational only and cannot receive resources directly.`);
        }
        return category;
    }
    async #getRouter(agentId) {
        const existing = this.#routerPromises.get(agentId);
        if (existing) {
            return existing;
        }
        const promise = (async () => {
            const taxonomy = this.#getTaxonomy(agentId);
            const embedder = new ResourceRoutingEmbeddingClient(this.#config.embedding, { transport: this.#embeddingTransport });
            const reranker = new ResourceRoutingRerankerClient(this.#config.reranker, { transport: this.#rerankerTransport });
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
        }
        catch (error) {
            this.#routerPromises.delete(agentId);
            throw error;
        }
    }
    async initializeAgent(agentId) {
        if (!this.#config.enabled) {
            return;
        }
        await this.#getRouter(agentId);
    }
    async preloadAgents(agentIds, logger) {
        const ready = [];
        const failed = [];
        if (!this.#config.enabled) {
            return { ready, failed };
        }
        const uniqueAgentIds = [...new Set(agentIds.map((agentId) => agentId.trim()).filter(Boolean))].sort();
        for (const agentId of uniqueAgentIds) {
            try {
                await this.initializeAgent(agentId);
                ready.push(agentId);
                logger.info(`openviking: resource routing ready for agent ${agentId}`);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                failed.push({ agentId, error: message });
                logger.error(`openviking: resource routing preload failed for agent ${agentId}: ${message}. ` +
                    "Automatic add_resource for this agent remains fail-closed until the taxonomy/config or model service is fixed; restart the gateway after taxonomy/config changes.");
            }
        }
        return { ready, failed };
    }
    async routeAutomatic(input) {
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
                    timing: {
                        embeddingMs: decision.timing.embeddingMs,
                        rerankerMs: decision.timing.rerankerMs,
                        totalMs: performance.now() - started,
                    },
                    status: "success",
                });
            }
            return { category, decision, semanticInput };
        }
        catch (error) {
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
                }
                catch {
                    // Never replace the original routing failure with an audit-write failure.
                }
            }
            throw error;
        }
    }
}
