import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export const RESOURCE_ROUTING_CACHE_SCHEMA_VERSION = 1;
export function computeResourceRoutingEmbeddingIdentity(input) {
    const canonicalHeaders = Object.entries(input.headers)
        .sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()))
        .map(([name, value]) => [name.toLowerCase(), value]);
    const canonical = JSON.stringify({
        baseUrl: input.baseUrl.replace(/\/+$/, ""),
        model: input.model,
        apiKey: input.apiKey,
        headers: canonicalHeaders,
    });
    return createHash("sha256").update(canonical, "utf8").digest("hex");
}
function nonEmptyString(value, label) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value.trim();
}
function positiveInteger(value, label) {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive integer`);
    }
    return value;
}
function parseVector(value, dimensions, label) {
    if (!Array.isArray(value) || value.length !== dimensions) {
        throw new Error(`${label} must contain exactly ${dimensions} dimensions`);
    }
    let normSquared = 0;
    const vector = value.map((entry, index) => {
        if (typeof entry !== "number" || !Number.isFinite(entry)) {
            throw new Error(`${label}[${index}] must be a finite number`);
        }
        normSquared += entry * entry;
        return entry;
    });
    if (!Number.isFinite(normSquared) || normSquared <= 0) {
        throw new Error(`${label} must have a finite non-zero norm`);
    }
    return vector;
}
export function parseResourceRoutingEmbeddingCache(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("resource routing cache must be an object");
    }
    const raw = value;
    const allowed = new Set([
        "schemaVersion",
        "taxonomyHash",
        "embeddingModel",
        "embeddingIdentity",
        "dimensions",
        "categories",
    ]);
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
        throw new Error(`resource routing cache has unknown keys: ${unknown.join(", ")}`);
    }
    if (raw.schemaVersion !== RESOURCE_ROUTING_CACHE_SCHEMA_VERSION) {
        throw new Error(`resource routing cache schemaVersion must be ${RESOURCE_ROUTING_CACHE_SCHEMA_VERSION}`);
    }
    const dimensions = positiveInteger(raw.dimensions, "resource routing cache dimensions");
    if (!Array.isArray(raw.categories) || raw.categories.length === 0) {
        throw new Error("resource routing cache categories must be a non-empty array");
    }
    const seen = new Set();
    const categories = raw.categories.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(`resource routing cache categories[${index}] must be an object`);
        }
        const category = entry;
        const categoryUnknown = Object.keys(category).filter((key) => key !== "key" && key !== "embedding");
        if (categoryUnknown.length > 0) {
            throw new Error(`resource routing cache categories[${index}] has unknown keys: ${categoryUnknown.join(", ")}`);
        }
        const key = nonEmptyString(category.key, `resource routing cache categories[${index}].key`);
        if (seen.has(key)) {
            throw new Error(`resource routing cache category key ${JSON.stringify(key)} is duplicated`);
        }
        seen.add(key);
        return {
            key,
            embedding: parseVector(category.embedding, dimensions, `resource routing cache categories[${index}].embedding`),
        };
    });
    return {
        schemaVersion: RESOURCE_ROUTING_CACHE_SCHEMA_VERSION,
        taxonomyHash: nonEmptyString(raw.taxonomyHash, "resource routing cache taxonomyHash"),
        embeddingModel: nonEmptyString(raw.embeddingModel, "resource routing cache embeddingModel"),
        embeddingIdentity: nonEmptyString(raw.embeddingIdentity, "resource routing cache embeddingIdentity"),
        dimensions,
        categories,
    };
}
function sameCategoryKeys(actual, expected) {
    if (actual.length !== expected.length) {
        return false;
    }
    const actualKeys = [...actual.map((entry) => entry.key)].sort();
    const expectedKeys = [...expected].sort();
    return actualKeys.every((key, index) => key === expectedKeys[index]);
}
export function loadResourceRoutingEmbeddingCache(filePath, expected) {
    if (!existsSync(filePath)) {
        return { hit: false, reason: "missing" };
    }
    let parsed;
    try {
        const text = readFileSync(filePath, "utf8");
        parsed = parseResourceRoutingEmbeddingCache(JSON.parse(text));
    }
    catch (error) {
        return {
            hit: false,
            reason: `invalid: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    if (parsed.taxonomyHash !== expected.taxonomyHash) {
        return { hit: false, reason: "taxonomy_hash_mismatch" };
    }
    if (parsed.embeddingModel !== expected.embeddingModel) {
        return { hit: false, reason: "embedding_model_mismatch" };
    }
    if (parsed.embeddingIdentity !== expected.embeddingIdentity) {
        return { hit: false, reason: "embedding_identity_mismatch" };
    }
    if (parsed.dimensions !== expected.dimensions) {
        return { hit: false, reason: "dimensions_mismatch" };
    }
    if (!sameCategoryKeys(parsed.categories, expected.categoryKeys)) {
        return { hit: false, reason: "category_keys_mismatch" };
    }
    return { hit: true, cache: parsed };
}
export function writeResourceRoutingEmbeddingCacheAtomic(filePath, cache) {
    const validated = parseResourceRoutingEmbeddingCache(cache);
    mkdirSync(dirname(filePath), { recursive: true });
    const suffix = randomBytes(8).toString("hex");
    const tempPath = `${filePath}.tmp-${process.pid}-${suffix}`;
    const payload = `${JSON.stringify(validated)}\n`;
    let fd;
    try {
        fd = openSync(tempPath, "wx", 0o600);
        writeFileSync(fd, payload, { encoding: "utf8" });
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(tempPath, filePath);
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {
                // Best-effort cleanup only.
            }
        }
        try {
            unlinkSync(tempPath);
        }
        catch {
            // Temp file may not exist or may already have been renamed.
        }
        throw error;
    }
}
