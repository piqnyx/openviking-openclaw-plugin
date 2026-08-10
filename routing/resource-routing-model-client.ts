import type { HttpTransport } from "../adapters/http-transport.js";
import { defaultHttpTransport } from "../adapters/http-transport.js";
import type { ParsedResourceRoutingEndpointConfig } from "./resource-routing-config.js";

export type ResourceRoutingEmbeddingEndpointConfig = ParsedResourceRoutingEndpointConfig & {
  dimensions: number;
};

export type ResourceRoutingRerankResult = {
  index: number;
  score: number;
};

type ClientOptions = {
  transport?: HttpTransport;
};

function endpointUrl(baseUrl: string, endpoint: "embeddings" | "rerank"): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/v1")
    ? `${normalized}/${endpoint}`
    : `${normalized}/v1/${endpoint}`;
}

function requestHeaders(config: ParsedResourceRoutingEndpointConfig): Headers {
  const headers = new Headers(config.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  if (config.apiKey && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${config.apiKey}`);
  }
  return headers;
}

async function readResponsePayload(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    const compact = text.trim().slice(0, 1_000);
    throw new Error(
      `${label} request failed with HTTP ${response.status}${compact ? `: ${compact}` : ""}`,
    );
  }
  try {
    return text ? JSON.parse(text) as unknown : null;
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

async function postJson(
  url: string,
  body: unknown,
  config: ParsedResourceRoutingEndpointConfig,
  label: string,
  transport: HttpTransport,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await transport(url, {
      method: "POST",
      headers: requestHeaders(config),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await readResponsePayload(response, label);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} request timed out after ${config.timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function integerIndex(value: unknown, count: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= count) {
    throw new Error(`${label} must be an integer between 0 and ${count - 1}`);
  }
  return value as number;
}

function validateEmbeddingVector(value: unknown, dimensions: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== dimensions) {
    throw new Error(`${label} must contain exactly ${dimensions} dimensions`);
  }
  const vector = value.map((entry, index) => finiteNumber(entry, `${label}[${index}]`));
  let normSquared = 0;
  for (const entry of vector) {
    normSquared += entry * entry;
  }
  if (!Number.isFinite(normSquared) || normSquared <= 0) {
    throw new Error(`${label} must have a finite non-zero norm`);
  }
  return vector;
}

function parseEmbeddingResponse(payload: unknown, count: number, dimensions: number): number[][] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("resource routing embedder returned an invalid response object");
  }
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length !== count) {
    throw new Error(`resource routing embedder must return exactly ${count} embedding records`);
  }

  const vectors = new Array<number[]>(count);
  const seen = new Set<number>();
  for (let position = 0; position < data.length; position += 1) {
    const record = data[position];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`resource routing embedder data[${position}] must be an object`);
    }
    const raw = record as Record<string, unknown>;
    const index = integerIndex(raw.index, count, `resource routing embedder data[${position}].index`);
    if (seen.has(index)) {
      throw new Error(`resource routing embedder returned duplicate index ${index}`);
    }
    seen.add(index);
    vectors[index] = validateEmbeddingVector(
      raw.embedding,
      dimensions,
      `resource routing embedder data[${position}].embedding`,
    );
  }

  if (seen.size !== count) {
    throw new Error("resource routing embedder response is missing one or more input indexes");
  }
  return vectors;
}

function parseRerankRecord(
  record: unknown,
  position: number,
  count: number,
): ResourceRoutingRerankResult {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`resource routing reranker result[${position}] must be an object`);
  }
  const raw = record as Record<string, unknown>;
  const index = integerIndex(raw.index, count, `resource routing reranker result[${position}].index`);
  const rawScore = raw.relevance_score ?? raw.score;
  const score = finiteNumber(rawScore, `resource routing reranker result[${position}].score`);
  return { index, score };
}

function parseRerankResponse(payload: unknown, count: number): ResourceRoutingRerankResult[] {
  const rawResults = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).results
      : undefined;
  if (!Array.isArray(rawResults) || rawResults.length !== count) {
    throw new Error(`resource routing reranker must return exactly ${count} results`);
  }

  const seen = new Set<number>();
  const results = rawResults.map((record, position) => {
    const parsed = parseRerankRecord(record, position, count);
    if (seen.has(parsed.index)) {
      throw new Error(`resource routing reranker returned duplicate index ${parsed.index}`);
    }
    seen.add(parsed.index);
    return parsed;
  });
  if (seen.size !== count) {
    throw new Error("resource routing reranker response is missing one or more candidate indexes");
  }
  return results.sort((left, right) => right.score - left.score || left.index - right.index);
}

export class ResourceRoutingEmbeddingClient {
  readonly #config: ResourceRoutingEmbeddingEndpointConfig;
  readonly #transport: HttpTransport;

  constructor(config: ResourceRoutingEmbeddingEndpointConfig, options: ClientOptions = {}) {
    this.#config = config;
    this.#transport = options.transport ?? defaultHttpTransport;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error("resource routing embedder requires at least one input string");
    }
    const normalized = texts.map((text, index) => {
      if (typeof text !== "string" || !text.trim()) {
        throw new Error(`resource routing embedder input[${index}] must be a non-empty string`);
      }
      return text;
    });
    const payload = await postJson(
      endpointUrl(this.#config.baseUrl, "embeddings"),
      {
        model: this.#config.model,
        input: normalized,
        encoding_format: "float",
      },
      this.#config,
      "resource routing embedder",
      this.#transport,
    );
    return parseEmbeddingResponse(payload, normalized.length, this.#config.dimensions);
  }
}

export class ResourceRoutingRerankerClient {
  readonly #config: ParsedResourceRoutingEndpointConfig;
  readonly #transport: HttpTransport;

  constructor(config: ParsedResourceRoutingEndpointConfig, options: ClientOptions = {}) {
    this.#config = config;
    this.#transport = options.transport ?? defaultHttpTransport;
  }

  async rerank(query: string, documents: readonly string[]): Promise<ResourceRoutingRerankResult[]> {
    if (typeof query !== "string" || !query.trim()) {
      throw new Error("resource routing reranker query must be a non-empty string");
    }
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new Error("resource routing reranker requires at least one candidate document");
    }
    const normalized = documents.map((document, index) => {
      if (typeof document !== "string" || !document.trim()) {
        throw new Error(`resource routing reranker document[${index}] must be a non-empty string`);
      }
      return document;
    });
    const payload = await postJson(
      endpointUrl(this.#config.baseUrl, "rerank"),
      {
        model: this.#config.model,
        query,
        documents: normalized,
        top_n: normalized.length,
      },
      this.#config,
      "resource routing reranker",
      this.#transport,
    );
    return parseRerankResponse(payload, normalized.length);
  }
}
