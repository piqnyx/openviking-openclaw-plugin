import { performance } from "node:perf_hooks";
import { computeResourceRoutingEmbeddingIdentity, loadResourceRoutingEmbeddingCache, writeResourceRoutingEmbeddingCacheAtomic, } from "./resource-routing-cache.js";
import { selectTopCosineCandidates, } from "./resource-routing-retrieval.js";
import { resolvePerAgentFileTemplate, } from "./resource-taxonomy.js";
function ensureConfiguredFallback(taxonomy, configuredFallback) {
    if (taxonomy.fallbackKey !== configuredFallback) {
        throw new Error(`resource routing fallback mismatch: config selects ${JSON.stringify(configuredFallback)} but taxonomy declares ${JSON.stringify(taxonomy.fallbackKey)}`);
    }
    const fallback = taxonomy.byKey.get(configuredFallback);
    if (!fallback || !fallback.routeable) {
        throw new Error(`resource routing fallback category ${JSON.stringify(configuredFallback)} is missing or not routeable`);
    }
}
function embeddingIdentity(config) {
    return computeResourceRoutingEmbeddingIdentity({
        baseUrl: config.embedding.baseUrl,
        model: config.embedding.model,
        apiKey: config.embedding.apiKey,
        headers: config.embedding.headers,
    });
}
function cacheFromVectors(taxonomy, config, vectors) {
    if (vectors.length !== taxonomy.semanticCategories.length) {
        throw new Error(`resource routing embedder returned ${vectors.length} category embeddings for ${taxonomy.semanticCategories.length} semantic categories`);
    }
    return {
        schemaVersion: 1,
        taxonomyHash: taxonomy.taxonomyHash,
        embeddingModel: config.embedding.model,
        embeddingIdentity: embeddingIdentity(config),
        dimensions: config.embedding.dimensions,
        categories: taxonomy.semanticCategories.map((category, index) => ({
            key: category.key,
            embedding: [...vectors[index]],
        })),
    };
}
function embeddedCategoriesFromCache(taxonomy, cache) {
    const vectors = new Map(cache.categories.map((entry) => [entry.key, entry.embedding]));
    return taxonomy.semanticCategories.map((category) => {
        const embedding = vectors.get(category.key);
        if (!embedding) {
            throw new Error(`resource routing cache is missing category ${JSON.stringify(category.key)}`);
        }
        return {
            key: category.key,
            path: category.path,
            embeddingText: category.embeddingText,
            rerankText: category.rerankText,
            embedding,
        };
    });
}
export async function buildResourceRoutingEmbeddingState(input) {
    ensureConfiguredFallback(input.taxonomy, input.config.fallbackCategory);
    const cacheFile = resolvePerAgentFileTemplate(input.config.cacheFile, input.agentId);
    const expected = {
        taxonomyHash: input.taxonomy.taxonomyHash,
        embeddingModel: input.config.embedding.model,
        embeddingIdentity: embeddingIdentity(input.config),
        dimensions: input.config.embedding.dimensions,
        categoryKeys: input.taxonomy.semanticCategories.map((category) => category.key),
    };
    const cached = loadResourceRoutingEmbeddingCache(cacheFile, expected);
    if (cached.hit) {
        return {
            source: "cache",
            categories: embeddedCategoriesFromCache(input.taxonomy, cached.cache),
        };
    }
    // Cold-cache construction is intentionally sequential. Local CPU embedders can
    // process a large taxonomy reliably one category at a time while keeping the
    // normal per-request timeout useful for ordinary single-summary routing calls.
    // The fallback category is deliberately excluded: it is a destination for low
    // confidence, never a semantic candidate. Nothing is persisted until every
    // semantic category has been embedded successfully.
    const vectors = [];
    for (const category of input.taxonomy.semanticCategories) {
        const [embedding] = await input.embedder.embed([category.embeddingText]);
        if (!embedding) {
            throw new Error(`resource routing embedder returned no embedding for category ${JSON.stringify(category.key)}`);
        }
        vectors.push(embedding);
    }
    const cache = cacheFromVectors(input.taxonomy, input.config, vectors);
    writeResourceRoutingEmbeddingCacheAtomic(cacheFile, cache);
    return {
        source: "recomputed",
        cacheMissReason: cached.reason,
        categories: embeddedCategoriesFromCache(input.taxonomy, cache),
    };
}
export class ResourceRouter {
    #taxonomy;
    #config;
    #embeddings;
    #embedder;
    #reranker;
    constructor(input) {
        ensureConfiguredFallback(input.taxonomy, input.config.fallbackCategory);
        this.#taxonomy = input.taxonomy;
        this.#config = input.config;
        this.#embeddings = input.embeddings;
        this.#embedder = input.embedder;
        this.#reranker = input.reranker;
    }
    async route(semanticInput) {
        if (typeof semanticInput !== "string" || !semanticInput.trim()) {
            throw new Error("resource routing semantic input must be a non-empty string");
        }
        const started = performance.now();
        const embeddingStarted = performance.now();
        const [queryEmbedding] = await this.#embedder.embed([semanticInput]);
        const embeddingMs = performance.now() - embeddingStarted;
        if (!queryEmbedding) {
            throw new Error("resource routing embedder returned no query embedding");
        }
        const embeddingCandidates = selectTopCosineCandidates(queryEmbedding, this.#embeddings.categories, this.#config.retrieval.topK);
        const top = embeddingCandidates[0];
        if (!top) {
            throw new Error("resource routing produced no semantic candidates");
        }
        if (top.score < this.#config.retrieval.minScore) {
            const fallback = this.#taxonomy.byKey.get(this.#config.fallbackCategory);
            if (!fallback || !fallback.routeable) {
                throw new Error("resource routing configured fallback disappeared from the validated taxonomy");
            }
            return {
                categoryKey: fallback.key,
                uri: fallback.uri,
                fallback: true,
                fallbackReason: "below_min_score",
                embeddingCandidates,
                rerankerUsed: false,
                timing: {
                    embeddingMs,
                    totalMs: performance.now() - started,
                },
            };
        }
        const second = embeddingCandidates[1];
        const shouldRerank = Boolean(second &&
            top.score - second.score < this.#config.retrieval.rerankBelowMargin);
        if (!shouldRerank || !second) {
            const selected = this.#taxonomy.byKey.get(top.key);
            if (!selected || !selected.routeable || selected.key === this.#taxonomy.fallbackKey) {
                throw new Error(`resource routing selected invalid semantic category ${JSON.stringify(top.key)}`);
            }
            return {
                categoryKey: selected.key,
                uri: selected.uri,
                fallback: false,
                embeddingCandidates,
                rerankerUsed: false,
                timing: {
                    embeddingMs,
                    totalMs: performance.now() - started,
                },
            };
        }
        const rerankCandidates = embeddingCandidates;
        const rerankerStarted = performance.now();
        const reranked = await this.#reranker.rerank(semanticInput, rerankCandidates.map((candidate) => candidate.rerankText));
        const rerankerMs = performance.now() - rerankerStarted;
        const rerankerScores = reranked.map((result) => {
            const candidate = rerankCandidates[result.index];
            if (!candidate) {
                throw new Error(`resource routing reranker selected invalid candidate index ${result.index}`);
            }
            return { key: candidate.key, path: candidate.path, score: result.score };
        });
        const selectedKey = rerankerScores[0]?.key;
        if (!selectedKey) {
            throw new Error("resource routing reranker returned no selected category");
        }
        const selected = this.#taxonomy.byKey.get(selectedKey);
        if (!selected || !selected.routeable || selected.key === this.#taxonomy.fallbackKey) {
            throw new Error(`resource routing reranker selected invalid semantic category ${JSON.stringify(selectedKey)}`);
        }
        return {
            categoryKey: selected.key,
            uri: selected.uri,
            fallback: false,
            embeddingCandidates,
            rerankerUsed: true,
            rerankerScores,
            timing: {
                embeddingMs,
                rerankerMs,
                totalMs: performance.now() - started,
            },
        };
    }
}
