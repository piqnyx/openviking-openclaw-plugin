import type { ParsedResourceRoutingConfig } from "./config.js";
import { decideAutomaticResourceRoute, type ResourceRoutingDecision } from "./decision.js";
import {
  ResourceEmbeddingClient,
  ResourceRerankerClient,
  type ResourceRoutingHttpTransport,
} from "./ml-client.js";
import {
  prepareAgentResourceRoutingState,
  type PreparedAgentResourceRoutingState,
} from "./state.js";

export type ResourceRoutingManagerLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

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
};

export class ResourceRoutingManager {
  private readonly embedder: ResourceEmbeddingClient;
  private readonly reranker: ResourceRerankerClient;
  private readonly statePromises = new Map<string, Promise<PreparedAgentResourceRoutingState>>();
  private readonly prepareState: typeof prepareAgentResourceRoutingState;

  constructor(
    private readonly config: ParsedResourceRoutingConfig,
    private readonly logger: ResourceRoutingManagerLogger,
    options: ResourceRoutingManagerOptions = {},
  ) {
    this.embedder = new ResourceEmbeddingClient(config.embedding, options.embeddingTransport);
    this.reranker = new ResourceRerankerClient(config.reranker, options.rerankerTransport);
    this.prepareState = options.prepareState ?? prepareAgentResourceRoutingState;
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
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`openviking: resource routing unavailable for agent "${agentId}": ${message}`);
        results.push({ agentId, ok: false, error: message });
      }
    }
    return results;
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
}
