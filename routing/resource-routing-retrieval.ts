export type ResourceRoutingEmbeddedCategory = {
  key: string;
  path: string;
  routingText: string;
  embedding: readonly number[];
};

export type ResourceRoutingCandidate = {
  key: string;
  path: string;
  routingText: string;
  score: number;
};

function assertFiniteVector(vector: readonly number[], label: string): void {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(`${label} must be a non-empty vector`);
  }
  for (let index = 0; index < vector.length; index += 1) {
    if (typeof vector[index] !== "number" || !Number.isFinite(vector[index])) {
      throw new Error(`${label}[${index}] must be a finite number`);
    }
  }
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  assertFiniteVector(left, "cosine left vector");
  assertFiniteVector(right, "cosine right vector");
  if (left.length !== right.length) {
    throw new Error(`cosine vector dimensions differ: ${left.length} != ${right.length}`);
  }

  let dot = 0;
  let leftNormSquared = 0;
  let rightNormSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index];
    const r = right[index];
    dot += l * r;
    leftNormSquared += l * l;
    rightNormSquared += r * r;
  }
  if (leftNormSquared <= 0 || rightNormSquared <= 0) {
    throw new Error("cosine similarity requires non-zero vectors");
  }
  const score = dot / Math.sqrt(leftNormSquared * rightNormSquared);
  if (!Number.isFinite(score)) {
    throw new Error("cosine similarity produced a non-finite score");
  }
  return Math.max(-1, Math.min(1, score));
}

export function selectTopCosineCandidates(
  queryEmbedding: readonly number[],
  categories: readonly ResourceRoutingEmbeddedCategory[],
  topK: number,
): ResourceRoutingCandidate[] {
  assertFiniteVector(queryEmbedding, "resource routing query embedding");
  if (!Number.isInteger(topK) || topK < 1) {
    throw new Error("resource routing topK must be a positive integer");
  }
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error("resource routing requires at least one embedded category");
  }

  const seen = new Set<string>();
  const scored = categories.map((category, index) => {
    if (!category || typeof category !== "object") {
      throw new Error(`resource routing category[${index}] must be an object`);
    }
    if (typeof category.key !== "string" || !category.key.trim()) {
      throw new Error(`resource routing category[${index}].key must be a non-empty string`);
    }
    if (seen.has(category.key)) {
      throw new Error(`resource routing embedded category key ${JSON.stringify(category.key)} is duplicated`);
    }
    seen.add(category.key);
    if (typeof category.path !== "string" || !category.path.trim()) {
      throw new Error(`resource routing category ${JSON.stringify(category.key)} path must be non-empty`);
    }
    if (typeof category.routingText !== "string" || !category.routingText.trim()) {
      throw new Error(`resource routing category ${JSON.stringify(category.key)} routingText must be non-empty`);
    }
    return {
      key: category.key,
      path: category.path,
      routingText: category.routingText,
      score: cosineSimilarity(queryEmbedding, category.embedding),
    };
  });

  scored.sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
  return scored.slice(0, Math.min(topK, scored.length));
}
