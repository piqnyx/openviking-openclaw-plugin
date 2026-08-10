import type {
  ParsedResourceRoutingHttpProviderConfig,
  ParsedResourceRoutingConfig,
} from "./config.js";

export type ResourceRoutingEmbeddingClient = {
  embed(inputs: readonly string[]): Promise<number[][]>;
};

export type ResourceRoutingRerankResult = {
  index: number;
  score: number;
};

export type ResourceRoutingRerankerClient = {
  rerank(query: string, documents: readonly string[]): Promise<ResourceRoutingRerankResult[]>;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildProviderUrl(config: ParsedResourceRoutingHttpProviderConfig): string {
  return `${config.baseUrl}${config.endpoint}`;
}

function providerHeaders(config: ParsedResourceRoutingHttpProviderConfig): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  for (const [key, value] of Object.entries(config.headers)) {
    headers.set(key, value);
  }
  if (config.apiKey && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${config.apiKey}`);
  }
  return headers;
}

function boundedErrorMessage(value: unknown): string | undefined {
  let message: string | undefined;
  if (isRecord(value)) {
    if (typeof value.message === "string") {
      message = value.message;
    } else if (typeof value.error === "string") {
      message = value.error;
    } else if (isRecord(value.error) && typeof value.error.message === "string") {
      message = value.error.message;
    }
  }
  if (!message) {
    return undefined;
  }
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}…` : compact;
}

async function postJson(
  config: ParsedResourceRoutingHttpProviderConfig,
  body: JsonRecord,
  label: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(buildProviderUrl(config), {
      method: "POST",
      headers: providerHeaders(config),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`${label} request timed out after ${config.timeoutMs} ms`, { cause: err });
    }
    throw new Error(
      `${label} request failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`, { cause: err });
  }
  if (!response.ok) {
    const detail = boundedErrorMessage(payload);
    throw new Error(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return payload;
}

function finiteVector(value: unknown, dimensions: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== dimensions) {
    throw new Error(`${label} must contain exactly ${dimensions} dimensions`);
  }
  if (value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`${label} contains non-finite or non-numeric values`);
  }
  return value as number[];
}

export function createResourceRoutingEmbeddingClient(
  config: ParsedResourceRoutingConfig["embedding"],
  fetchImpl: typeof fetch = fetch,
): ResourceRoutingEmbeddingClient {
  return {
    async embed(inputs: readonly string[]): Promise<number[][]> {
      if (inputs.length === 0) {
        return [];
      }
      if (inputs.some((input) => typeof input !== "string" || !input.trim())) {
        throw new Error("Resource routing embedding inputs must be non-empty strings");
      }
      const payload = await postJson(
        config,
        {
          model: config.model,
          input: [...inputs],
          encoding_format: "float",
        },
        "Resource routing embedder",
        fetchImpl,
      );
      if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length !== inputs.length) {
        throw new Error(
          `Resource routing embedder returned malformed data: expected ${inputs.length} embeddings`,
        );
      }

      const entries = payload.data;
      const hasAnyIndex = entries.some((entry) => isRecord(entry) && entry.index !== undefined);
      const vectors = new Array<number[]>(inputs.length);
      const seenIndices = new Set<number>();
      entries.forEach((entry, position) => {
        if (!isRecord(entry)) {
          throw new Error(`Resource routing embedder data[${position}] must be an object`);
        }
        let outputIndex = position;
        if (hasAnyIndex) {
          if (
            typeof entry.index !== "number" ||
            !Number.isInteger(entry.index) ||
            entry.index < 0 ||
            entry.index >= inputs.length ||
            seenIndices.has(entry.index)
          ) {
            throw new Error(`Resource routing embedder returned invalid index at data[${position}]`);
          }
          outputIndex = entry.index;
          seenIndices.add(outputIndex);
        }
        vectors[outputIndex] = finiteVector(
          entry.embedding,
          config.dimensions,
          `Resource routing embedder data[${position}].embedding`,
        );
      });
      if (vectors.some((vector) => !vector)) {
        throw new Error("Resource routing embedder did not return every requested embedding");
      }
      return vectors;
    },
  };
}

export function createResourceRoutingRerankerClient(
  config: ParsedResourceRoutingConfig["reranker"],
  fetchImpl: typeof fetch = fetch,
): ResourceRoutingRerankerClient {
  return {
    async rerank(query: string, documents: readonly string[]): Promise<ResourceRoutingRerankResult[]> {
      if (!query.trim()) {
        throw new Error("Resource routing reranker query must not be empty");
      }
      if (documents.length === 0) {
        return [];
      }
      if (documents.some((document) => typeof document !== "string" || !document.trim())) {
        throw new Error("Resource routing reranker documents must be non-empty strings");
      }
      const payload = await postJson(
        config,
        {
          model: config.model,
          query,
          documents: [...documents],
          top_n: documents.length,
        },
        "Resource routing reranker",
        fetchImpl,
      );
      if (!isRecord(payload) || !Array.isArray(payload.results)) {
        throw new Error("Resource routing reranker returned malformed results");
      }
      if (payload.results.length !== documents.length) {
        throw new Error(
          `Resource routing reranker returned ${payload.results.length} results for ${documents.length} documents`,
        );
      }

      const seen = new Set<number>();
      return payload.results.map((item, position) => {
        if (!isRecord(item)) {
          throw new Error(`Resource routing reranker results[${position}] must be an object`);
        }
        if (
          typeof item.index !== "number" ||
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          item.index >= documents.length ||
          seen.has(item.index)
        ) {
          throw new Error(`Resource routing reranker returned invalid index at results[${position}]`);
        }
        if (typeof item.relevance_score !== "number" || !Number.isFinite(item.relevance_score)) {
          throw new Error(
            `Resource routing reranker returned invalid relevance_score at results[${position}]`,
          );
        }
        seen.add(item.index);
        return {
          index: item.index,
          score: item.relevance_score,
        };
      });
    },
  };
}
