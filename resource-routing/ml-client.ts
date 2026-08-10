import type { ParsedResourceRoutingEndpoint } from "./config.js";

export type ResourceRoutingHttpTransport = (url: string, init: RequestInit) => Promise<Response>;

export type ResourceRerankResult = {
  index: number;
  score: number;
};

type EmbeddingEndpointConfig = ParsedResourceRoutingEndpoint & { dimensions: number };

function endpointUrl(config: ParsedResourceRoutingEndpoint): string {
  return `${config.baseUrl}${config.endpointPath}`;
}

function requestHeaders(config: ParsedResourceRoutingEndpoint): Headers {
  const headers = new Headers(config.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (config.apiKey && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${config.apiKey}`);
  }
  return headers;
}

function errorPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 600 ? normalized : `${normalized.slice(0, 600)}…`;
}

async function postJson(
  config: ParsedResourceRoutingEndpoint,
  body: unknown,
  label: string,
  transport: ResourceRoutingHttpTransport,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    let response: Response;
    try {
      response = await transport(endpointUrl(config), {
        method: "POST",
        headers: requestHeaders(config),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} request failed: ${detail}`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${label} request failed with HTTP ${response.status}${text ? `: ${errorPreview(text)}` : ""}`);
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch (error) {
      throw new Error(`${label} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requireIndex(value: unknown, upperBound: number, label: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value >= upperBound) {
    throw new Error(`${label} must be an integer between 0 and ${upperBound - 1}`);
  }
  return value;
}

export class ResourceEmbeddingClient {
  constructor(
    private readonly config: EmbeddingEndpointConfig,
    private readonly transport: ResourceRoutingHttpTransport = fetch,
  ) {}

  async embed(inputs: readonly string[]): Promise<number[][]> {
    if (inputs.length === 0) {
      throw new Error("embedding input must not be empty");
    }
    if (inputs.some((input) => typeof input !== "string" || !input.trim())) {
      throw new Error("embedding inputs must be non-empty strings");
    }

    const payload = await postJson(
      this.config,
      {
        model: this.config.model,
        input: [...inputs],
      },
      "resource routing embedding",
      this.transport,
    );

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("resource routing embedding response must be an object");
    }
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length !== inputs.length) {
      throw new Error(`resource routing embedding response must contain exactly ${inputs.length} data items`);
    }

    const ordered: Array<number[] | undefined> = new Array(inputs.length);
    for (const [position, rawItem] of data.entries()) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        throw new Error(`resource routing embedding data[${position}] is malformed`);
      }
      const item = rawItem as { index?: unknown; embedding?: unknown };
      const index = requireIndex(item.index, inputs.length, `resource routing embedding data[${position}].index`);
      if (ordered[index]) {
        throw new Error(`resource routing embedding response contains duplicate index ${index}`);
      }
      if (!Array.isArray(item.embedding) || item.embedding.length !== this.config.dimensions) {
        throw new Error(
          `resource routing embedding index ${index} has dimension ${Array.isArray(item.embedding) ? item.embedding.length : "invalid"}; expected ${this.config.dimensions}`,
        );
      }
      const vector = item.embedding.map((value, dimension) =>
        requireFiniteNumber(value, `resource routing embedding index ${index} dimension ${dimension}`),
      );
      ordered[index] = vector;
    }

    if (ordered.some((embedding) => !embedding)) {
      throw new Error("resource routing embedding response is missing one or more input indices");
    }
    return ordered as number[][];
  }
}

function extractRerankItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const results = (payload as { results?: unknown }).results;
    if (Array.isArray(results)) {
      return results;
    }
  }
  throw new Error("resource routing reranker response must be an array or an object with results[]");
}

export class ResourceRerankerClient {
  constructor(
    private readonly config: ParsedResourceRoutingEndpoint,
    private readonly transport: ResourceRoutingHttpTransport = fetch,
  ) {}

  async rerank(query: string, documents: readonly string[]): Promise<ResourceRerankResult[]> {
    if (!query.trim()) {
      throw new Error("reranker query must not be empty");
    }
    if (documents.length === 0 || documents.some((document) => !document.trim())) {
      throw new Error("reranker documents must be non-empty strings");
    }

    const payload = await postJson(
      this.config,
      {
        model: this.config.model,
        query,
        documents: [...documents],
        top_n: documents.length,
      },
      "resource routing reranker",
      this.transport,
    );

    const items = extractRerankItems(payload);
    if (items.length !== documents.length) {
      throw new Error(`resource routing reranker response must contain exactly ${documents.length} results`);
    }

    const seen = new Set<number>();
    const results: ResourceRerankResult[] = items.map((rawItem, position) => {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        throw new Error(`resource routing reranker result[${position}] is malformed`);
      }
      const item = rawItem as { index?: unknown; score?: unknown; relevance_score?: unknown };
      const index = requireIndex(item.index, documents.length, `resource routing reranker result[${position}].index`);
      if (seen.has(index)) {
        throw new Error(`resource routing reranker response contains duplicate index ${index}`);
      }
      seen.add(index);
      const scoreValue = item.score !== undefined ? item.score : item.relevance_score;
      const score = requireFiniteNumber(scoreValue, `resource routing reranker result[${position}].score`);
      return { index, score };
    });

    if (seen.size !== documents.length) {
      throw new Error("resource routing reranker response is missing one or more document indices");
    }
    return results.sort((left, right) => right.score - left.score || left.index - right.index);
  }
}
