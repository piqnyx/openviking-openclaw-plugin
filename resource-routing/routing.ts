import type { ParsedResourceRoutingConfig } from "./config.js";
import type {
  ResourceRoutingCategoryEmbeddingStore,
} from "./category-embeddings.js";
import { resourceCategoryEmbeddingInput } from "./category-embeddings.js";
import type { ResourceRoutingTaxonomyLoader } from "./loader.js";
import type {
  ResourceRoutingEmbeddingClient,
  ResourceRoutingRerankerClient,
} from "./providers.js";
import type { CompiledResourceCategory } from "./taxonomy.js";

const SUMMARY_MAX_CHARS = 2_000;

export type ResourceRoutingSemanticInput = {
  summary: string;
  filename?: string;
  extension?: string;
  mimeType?: string;
  sourceKind?: string;
  source?: string;
  reason?: string;
  instruction?: string;
  agentId?: string;
};

export type ResourceRoutingEmbeddingCandidate = {
  key: string;
  score: number;
};

export type ResourceRoutingRerankCandidate = {
  key: string;
  score: number;
};

export type ResourceRoutingDecision = {
  category: CompiledResourceCategory;
  reason: "embedding" | "reranker" | "fallback_low_score";
  semanticInput: string;
  embeddingCandidates: ResourceRoutingEmbeddingCandidate[];
  rerankerUsed: boolean;
  rerankerCandidates?: ResourceRoutingRerankCandidate[];
  fallbackReason?: "below_min_score";
};

export type ResourceRoutingDecisionEngine = {
  route(agentId: string, input: ResourceRoutingSemanticInput): Promise<ResourceRoutingDecision>;
};

function normalizeSummary(value: string): string {
  const summary = value.trim();
  if (!summary) {
    throw new Error(
      "Automatic resource routing requires `summary`. Describe the resource's semantic content and purpose in one short sentence, then retry add_resource.",
    );
  }
  if (summary.length > SUMMARY_MAX_CHARS) {
    throw new Error(
      `Automatic resource routing summary is too long (${summary.length} characters; maximum ${SUMMARY_MAX_CHARS}). Provide one short semantic sentence and retry add_resource.`,
    );
  }
  return summary;
}

export function renderResourceRoutingSemanticInput(
  template: string,
  input: ResourceRoutingSemanticInput,
): string {
  const values: Record<string, string> = {
    summary: normalizeSummary(input.summary),
    filename: input.filename?.trim() ?? "",
    extension: input.extension?.trim() ?? "",
    mimeType: input.mimeType?.trim() ?? "",
    sourceKind: input.sourceKind?.trim() ?? "",
    source: input.source?.trim() ?? "",
    reason: input.reason?.trim() ?? "",
    instruction: input.instruction?.trim() ?? "",
    agentId: input.agentId?.trim() ?? "",
  };
  const rendered = template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_, field: string) => {
    if (!(field in values)) {
      throw new Error(`Unsupported resource routing semantic template field: ${field}`);
    }
    return values[field]!;
  });
  const normalized = rendered.trim();
  if (!normalized) {
    throw new Error("Resource routing semantic input rendered to an empty string");
  }
  return normalized;
}

function vectorNorm(vector: readonly number[], label: string): number {
  let sum = 0;
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${label} contains non-finite or non-numeric values`);
    }
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm <= 0) {
    throw new Error(`${label} has zero or invalid magnitude`);
  }
  return norm;
}

export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length || left.length === 0) {
    throw new Error(
      `Cannot compute resource routing cosine similarity for dimensions ${left.length} and ${right.length}`,
    );
  }
  const leftNorm = vectorNorm(left, "Resource routing query embedding");
  const rightNorm = vectorNorm(right, "Resource routing category embedding");
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
  }
  const score = dot / (leftNorm * rightNorm);
  if (!Number.isFinite(score)) {
    throw new Error("Resource routing cosine similarity produced a non-finite score");
  }
  return Math.max(-1, Math.min(1, score));
}

export function rankResourceRoutingCandidates(options: {
  categories: readonly CompiledResourceCategory[];
  vectorsByCategoryKey: ReadonlyMap<string, number[]>;
  queryEmbedding: readonly number[];
  topK: number;
}): ResourceRoutingEmbeddingCandidate[] {
  if (options.categories.length === 0) {
    throw new Error("Resource routing taxonomy has no routeable categories");
  }
  const ranked = options.categories.map((category) => {
    const vector = options.vectorsByCategoryKey.get(category.key);
    if (!vector) {
      throw new Error(`Resource routing category embedding is missing for ${JSON.stringify(category.key)}`);
    }
    return {
      key: category.key,
      score: cosineSimilarity(options.queryEmbedding, vector),
    };
  });
  ranked.sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
  return ranked.slice(0, Math.min(options.topK, ranked.length));
}

export function createResourceRoutingDecisionEngine(options: {
  config: ParsedResourceRoutingConfig;
  loader: ResourceRoutingTaxonomyLoader;
  categoryEmbeddingStore: ResourceRoutingCategoryEmbeddingStore;
  embeddingClient: ResourceRoutingEmbeddingClient;
  rerankerClient: ResourceRoutingRerankerClient;
}): ResourceRoutingDecisionEngine {
  return {
    async route(agentId: string, input: ResourceRoutingSemanticInput): Promise<ResourceRoutingDecision> {
      const loaded = await options.loader.load(agentId);
      const prepared = await options.categoryEmbeddingStore.get(agentId);
      if (prepared.taxonomyHash !== loaded.taxonomy.taxonomyHash) {
        throw new Error(
          `Resource routing taxonomy/cache state mismatch for agent ${JSON.stringify(agentId)}`,
        );
      }

      const semanticInput = renderResourceRoutingSemanticInput(
        options.config.semanticInputTemplate,
        {
          ...input,
          agentId,
        },
      );
      const queryEmbeddings = await options.embeddingClient.embed([semanticInput]);
      if (queryEmbeddings.length !== 1) {
        throw new Error(
          `Resource routing embedder returned ${queryEmbeddings.length} query embeddings instead of 1`,
        );
      }

      const embeddingCandidates = rankResourceRoutingCandidates({
        categories: loaded.taxonomy.routeableCategories,
        vectorsByCategoryKey: prepared.vectorsByCategoryKey,
        queryEmbedding: queryEmbeddings[0]!,
        topK: options.config.retrieval.topK,
      });
      const top = embeddingCandidates[0]!;

      if (top.score < options.config.retrieval.minScore) {
        return {
          category: loaded.fallbackCategory,
          reason: "fallback_low_score",
          semanticInput,
          embeddingCandidates,
          rerankerUsed: false,
          fallbackReason: "below_min_score",
        };
      }

      const second = embeddingCandidates[1];
      const shouldRerank =
        Boolean(second) &&
        top.score - second!.score < options.config.retrieval.rerankBelowMargin;
      if (!shouldRerank) {
        const category = loaded.taxonomy.byKey.get(top.key);
        if (!category || !category.routeable) {
          throw new Error(
            `Resource routing selected invalid taxonomy category ${JSON.stringify(top.key)}`,
          );
        }
        return {
          category,
          reason: "embedding",
          semanticInput,
          embeddingCandidates,
          rerankerUsed: false,
        };
      }

      const rerankDocuments = embeddingCandidates.map((candidate) => {
        const category = loaded.taxonomy.byKey.get(candidate.key);
        if (!category || !category.routeable) {
          throw new Error(
            `Resource routing rerank candidate is invalid: ${JSON.stringify(candidate.key)}`,
          );
        }
        return resourceCategoryEmbeddingInput(category.description);
      });
      const reranked = await options.rerankerClient.rerank(semanticInput, rerankDocuments);
      if (reranked.length !== embeddingCandidates.length) {
        throw new Error(
          `Resource routing reranker returned ${reranked.length} results for ${embeddingCandidates.length} candidates`,
        );
      }
      const rerankerCandidates = reranked
        .map((result) => ({
          key: embeddingCandidates[result.index]!.key,
          score: result.score,
        }))
        .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
      const winner = rerankerCandidates[0];
      if (!winner) {
        throw new Error("Resource routing reranker returned no winner");
      }
      const category = loaded.taxonomy.byKey.get(winner.key);
      if (!category || !category.routeable) {
        throw new Error(
          `Resource routing reranker selected invalid taxonomy category ${JSON.stringify(winner.key)}`,
        );
      }
      return {
        category,
        reason: "reranker",
        semanticInput,
        embeddingCandidates,
        rerankerUsed: true,
        rerankerCandidates,
      };
    },
  };
}
