import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createResourceRoutingCategoryEmbeddingStore,
  prepareResourceCategoryEmbeddings,
} from "../resource-routing/category-embeddings.js";
import { parseResourceRoutingConfig } from "../resource-routing/config.js";
import { createResourceRoutingTaxonomyLoader } from "../resource-routing/loader.js";
import type { ResourceRoutingEmbeddingClient } from "../resource-routing/providers.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ov-resource-category-embeddings-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const TAXONOMY = `schemaVersion: 1
categories:
  inbox:
    segment: __INBOX__
    description: Resources that cannot be classified confidently.
  security:
    segment: security
    description: General security-focused material.
    children:
      security-audits:
        segment: audits
        description: Security audits, reviews, findings, and remediation material.
`;

function config(dir: string) {
  return parseResourceRoutingConfig({
    enabled: true,
    taxonomyFileTemplate: join(dir, "{agentId}.yaml"),
    cacheFileTemplate: join(dir, "cache", "{agentId}.json"),
    embedding: {
      model: "test-embedder",
      dimensions: 3,
    },
  });
}

function fakeEmbeddingClient() {
  const embed = vi.fn(async (inputs: readonly string[]) =>
    inputs.map((_, index) => [index + 1, index + 2, index + 3]),
  );
  return {
    client: { embed } satisfies ResourceRoutingEmbeddingClient,
    embed,
  };
}

describe("resource category embedding preparation", () => {
  it("embeds only semantic category descriptions and persists the resulting cache", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "main.yaml"), TAXONOMY, "utf8");
    const cfg = config(dir);
    const loaded = await createResourceRoutingTaxonomyLoader(cfg).load("main");
    const { client, embed } = fakeEmbeddingClient();

    const prepared = await prepareResourceCategoryEmbeddings(
      loaded,
      client,
      cfg.embedding.model,
      cfg.embedding.dimensions,
    );

    expect(prepared.source).toBe("embedder");
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith([
      "Resources that cannot be classified confidently.",
      "General security-focused material.",
      "Security audits, reviews, findings, and remediation material.",
    ]);
    expect(prepared.vectorsByCategoryKey.get("security-audits")).toEqual([3, 4, 5]);

    const reloaded = await createResourceRoutingTaxonomyLoader(cfg).load("main");
    expect(reloaded.embeddingCache.status).toBe("hit");
  });

  it("uses a valid disk cache without calling the embedder again", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "main.yaml"), TAXONOMY, "utf8");
    const cfg = config(dir);
    const firstClient = fakeEmbeddingClient();
    const firstLoaded = await createResourceRoutingTaxonomyLoader(cfg).load("main");
    await prepareResourceCategoryEmbeddings(
      firstLoaded,
      firstClient.client,
      cfg.embedding.model,
      cfg.embedding.dimensions,
    );

    const secondClient = fakeEmbeddingClient();
    const secondLoaded = await createResourceRoutingTaxonomyLoader(cfg).load("main");
    const prepared = await prepareResourceCategoryEmbeddings(
      secondLoaded,
      secondClient.client,
      cfg.embedding.model,
      cfg.embedding.dimensions,
    );

    expect(prepared.source).toBe("cache");
    expect(secondClient.embed).not.toHaveBeenCalled();
  });

  it("keeps prepared vectors in RAM per agent for the process lifetime", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "main.yaml"), TAXONOMY, "utf8");
    const cfg = config(dir);
    const loader = createResourceRoutingTaxonomyLoader(cfg);
    const { client, embed } = fakeEmbeddingClient();
    const store = createResourceRoutingCategoryEmbeddingStore({
      loader,
      embeddingClient: client,
      embeddingModel: cfg.embedding.model,
      dimensions: cfg.embedding.dimensions,
    });

    const first = await store.get("main");
    const second = await store.get("main");
    expect(second).toBe(first);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(store.has("main")).toBe(true);
  });

  it("keeps agents isolated even when they share the same model process", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "main.yaml"), TAXONOMY, "utf8");
    await writeFile(
      join(dir, "igor.yaml"),
      TAXONOMY.replace(
        "General security-focused material.",
        "Security material customized for Igor.",
      ),
      "utf8",
    );
    const cfg = config(dir);
    const loader = createResourceRoutingTaxonomyLoader(cfg);
    const { client, embed } = fakeEmbeddingClient();
    const store = createResourceRoutingCategoryEmbeddingStore({
      loader,
      embeddingClient: client,
      embeddingModel: cfg.embedding.model,
      dimensions: cfg.embedding.dimensions,
    });

    const main = await store.get("main");
    const igor = await store.get("igor");
    expect(main.taxonomyHash).not.toBe(igor.taxonomyHash);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(main.vectorsByCategoryKey).not.toBe(igor.vectorsByCategoryKey);
  });
});
