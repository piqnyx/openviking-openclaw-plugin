import {
  appendResourceRoutingAudit,
  createResourceRoutingAuditRecord,
  type ResourceRoutingAuditRecord,
} from "./audit.js";
import { resolveAgentResourceRoutingPaths, type ParsedResourceRoutingConfig } from "./config.js";
import { decideAutomaticResourceRoute, type ResourceRoutingDecision } from "./decision.js";
import {
  ResourceEmbeddingClient,
  ResourceRerankerClient,
  type ResourceRoutingHttpTransport,
} from "./ml-client.js";
import { renderResourceSemanticInput, type ResourceSemanticInputContext } from "./semantic-input.js";
import {
  prepareAgentResourceRoutingState,
  resourceEmbeddingModelIdentity,
  type PreparedAgentResourceRoutingState,
} from "./state.js";
import {
  assertResourceRoutingFallbackCategory,
  loadResourceTaxonomyFile,
  resolveResourceCategoryUri,
  type ResourceTaxonomy,
} from "./taxonomy.js";

export type ResourceRoutingManagerLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export class ResourceRoutingCategoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceRoutingCategoryError";
  }
}

export type ResourceRoutingAgentInitialization = {
  agentId: string;
  ok: boolean;
  cacheRebuilt?: boolean;
  error?: string;
};

export type ResourceRoutingManagerOptions = {
  embeddingTransport?: ResourceRoutingHttpTransport;
  rerankerTransport?: ResourceRoutingHttpTransport;
  prepareState?: typeof prepareAgentResourceRoutingState;
  loadTaxonomy?: typeof loadResourceTaxonomyFile;
  appendAudit?: (filePath: string, record: ResourceRoutingAuditRecord) => Promise<void>;
};

function compactLogText(value: unknown, maxChars = 600): string {
  const text = (value instanceof Error ? value.message : String(value)).replace(/\s+/g, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "invalid";
}

function formatEmbeddingCandidates(decision: ResourceRoutingDecision): string {
  return decision.embeddingTop
    .map((candidate) => `${candidate.key}:${formatScore(candidate.score)}`)
    .join(",");
}

function formatRerankerCandidates(decision: ResourceRoutingDecision): string {
  return (decision.rerankerScores ?? [])
    .map((candidate) => `${candidate.key}:${formatScore(candidate.score)}`)
    .join(",");
}

export class ResourceRoutingManager {
  private readonly embedder: ResourceEmbeddingClient;
  private readonly reranker: ResourceRerankerClient;
  private readonly statePromises = new Map<string, Promise<PreparedAgentResourceRoutingState>>();
  private readonly taxonomyPromises = new Map<string, Promise<ResourceTaxonomy>>();
  private readonly prepareState: typeof prepareAgentResourceRoutingState;
  private readonly loadTaxonomy: typeof loadResourceTaxonomyFile;
  private readonly appendAudit: (filePath: string, record: ResourceRoutingAuditRecord) => Promise<void>;

  constructor(
    private readonly config: ParsedResourceRoutingConfig,
    private readonly logger: ResourceRoutingManagerLogger,
    options: ResourceRoutingManagerOptions = {},
  ) {
    this.embedder = new ResourceEmbeddingClient(config.embedding, options.embeddingTransport);
    this.reranker = new ResourceRerankerClient(config.reranker, options.rerankerTransport);
    this.loadTaxonomy = options.loadTaxonomy ?? loadResourceTaxonomyFile;
    this.prepareState = options.prepareState ?? ((routingConfig, agentId, embedder) =>
      prepareAgentResourceRoutingState(routingConfig, agentId, embedder, {
        loadTaxonomy: async () => this.getAgentTaxonomy(agentId),
      }));
    this.appendAudit = options.appendAudit ?? appendResourceRoutingAudit;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async initializeKnownAgents(agentIds: readonly string[]): Promise<ResourceRoutingAgentInitialization[]> {
    if (!this.config.enabled) {
      return agentIds.map((agentId) => ({ agentId, ok: false, error: "resource routing disabled" }));
    }

    const results: ResourceRoutingAgentInitialization[] = [];
    for (const agentId of [...new Set(agentIds)].sort()) {
      try {
        const state = await this.getAgentState(agentId);
        this.logger.info(
          `openviking: resource routing ready for agent "${agentId}" ` +
            `(categories=${state.embeddings.size}, cache=${state.cache.rebuilt ? "rebuilt" : "hit"})`,
        );
        results.push({ agentId, ok: true, cacheRebuilt: state.cache.rebuilt });
      } catch (error) {
        const message = compactLogText(error);
        this.logger.warn(`openviking: resource routing unavailable for agent "${agentId}": ${message}`);
        results.push({ agentId, ok: false, error: message });
      }
    }
    return results;
  }

  async getAgentTaxonomy(agentId: string): Promise<ResourceTaxonomy> {
    if (!this.config.enabled) {
      throw new Error("resource routing is disabled");
    }
    const existing = this.taxonomyPromises.get(agentId);
    if (existing) {
      return existing;
    }

    const path = resolveAgentResourceRoutingPaths(this.config, agentId).taxonomyFile;
    const pending = this.loadTaxonomy(path).then((taxonomy) => {
      assertResourceRoutingFallbackCategory(taxonomy, this.config.fallbackCategory);
      return taxonomy;
    });
    this.taxonomyPromises.set(agentId, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.taxonomyPromises.get(agentId) === pending) {
        this.taxonomyPromises.delete(agentId);
      }
      throw error;
    }
  }

  async getAgentState(agentId: string): Promise<PreparedAgentResourceRoutingState> {
    if (!this.config.enabled) {
      throw new Error("resource routing is disabled");
    }
    const existing = this.statePromises.get(agentId);
    if (existing) {
      return existing;
    }

    const pending = this.prepareState(this.config, agentId, this.embedder);
    this.statePromises.set(agentId, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.statePromises.get(agentId) === pending) {
        this.statePromises.delete(agentId);
      }
      throw error;
    }
  }

  async resolveCategory(agentId: string, categoryKey: string): Promise<{ categoryKey: string; categoryUri: string }> {
    const key = categoryKey.trim();
    if (!key) {
      throw new ResourceRoutingCategoryError("resource routing category must not be empty");
    }
    const taxonomy = await this.getAgentTaxonomy(agentId);
    try {
      return {
        categoryKey: key,
        categoryUri: resolveResourceCategoryUri(taxonomy, key),
      };
    } catch (error) {
      throw new ResourceRoutingCategoryError(error instanceof Error ? error.message : String(error));
    }
  }

  async route(agentId: string, semanticInput: string): Promise<ResourceRoutingDecision> {
    const state = await this.getAgentState(agentId);
    return decideAutomaticResourceRoute({
      semanticInput,
      config: this.config,
      state,
      embedder: this.embedder,
      reranker: this.reranker,
    });
  }

  private async appendAuditBestEffort(
    filePath: string,
    record: ResourceRoutingAuditRecord,
  ): Promise<void> {
    if (!this.config.audit.enabled) {
      return;
    }
    try {
      await this.appendAudit(filePath, record);
    } catch (error) {
      this.logger.warn(
        `openviking: resource routing audit write failed for agent "${record.agentId}": ` +
          compactLogText(error),
      );
    }
  }

  private logDecision(agentId: string, decision: ResourceRoutingDecision): void {
    if (!this.config.logDecisions) {
      return;
    }
    const rerank = decision.rerankerUsed
      ? ` rerank=[${formatRerankerCandidates(decision)}]`
      : "";
    this.logger.info(
      `openviking: resource routing decision agent="${agentId}" ` +
        `category="${decision.categoryKey}" fallback=${decision.fallback} ` +
        `reranker=${decision.rerankerUsed} cosine=[${formatEmbeddingCandidates(decision)}]${rerank} ` +
        `timing_ms=${JSON.stringify(decision.timingMs)}`,
    );
  }

  async routeResource(
    agentId: string,
    context: ResourceSemanticInputContext,
  ): Promise<ResourceRoutingDecision> {
    const routeStartedAt = Date.now();
    const semanticInput = renderResourceSemanticInput(this.config.semanticInputTemplate, {
      ...context,
      agentId,
    });
    const source = context.source ?? "";
    const summary = context.summary;
    const defaultAuditPath = resolveAgentResourceRoutingPaths(this.config, agentId).auditFile;
    let state: PreparedAgentResourceRoutingState | undefined;

    try {
      state = await this.getAgentState(agentId);
      const rawDecision = await decideAutomaticResourceRoute({
        semanticInput,
        config: this.config,
        state,
        embedder: this.embedder,
        reranker: this.reranker,
      });
      const decision: ResourceRoutingDecision = {
        ...rawDecision,
        timingMs: {
          ...rawDecision.timingMs,
          total: Date.now() - routeStartedAt,
        },
      };
      this.logDecision(agentId, decision);
      await this.appendAuditBestEffort(
        state.paths.auditFile,
        createResourceRoutingAuditRecord({
          agentId,
          source,
          summary,
          includeSummaryPreview: this.config.audit.includeSummaryPreview,
          summaryPreviewChars: this.config.audit.summaryPreviewChars,
          taxonomyHash: state.taxonomyHash,
          embeddingModel: resourceEmbeddingModelIdentity(this.config),
          decision,
          outcome: "success",
        }),
      );
      return decision;
    } catch (error) {
      const message = compactLogText(error);
      this.logger.warn(
        `openviking: resource routing failed for agent "${agentId}"; resource not imported: ${message}`,
      );
      await this.appendAuditBestEffort(
        state?.paths.auditFile ?? defaultAuditPath,
        createResourceRoutingAuditRecord({
          agentId,
          source,
          summary,
          includeSummaryPreview: this.config.audit.includeSummaryPreview,
          summaryPreviewChars: this.config.audit.summaryPreviewChars,
          taxonomyHash: state?.taxonomyHash,
          embeddingModel: resourceEmbeddingModelIdentity(this.config),
          outcome: "error",
          errorCode: "routing_infrastructure_error",
          errorMessage: message,
        }),
      );
      throw error;
    }
  }
}
