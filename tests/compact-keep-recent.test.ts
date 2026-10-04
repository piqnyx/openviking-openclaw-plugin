import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";

/*
 * Что остаётся в окне после сжатия, которое просит сам шлюз (Вит, 04.10.2026).
 *
 * Шлюз зовёт compact движка двумя способами и помечает их: автоматическое сжатие
 * перед запуском, когда переписка подошла к окну, идёт со словом "budget"; ручной
 * /compact -- со словом "threshold". Раньше compact всегда сворачивал всё, и после
 * автоматического сжатия окно состояло из одной сводки. Теперь автоматическое
 * оставляет последние сообщения, сколько задано в commitKeepRecentCount, как и
 * сводка по порогу; ручное сворачивает всё, как было. Если оставленный хвост сам
 * не влезает в бюджет шлюза, коммит повторяется без хвоста: сжатие обязано
 * привести окно под бюджет.
 */

type Fake = {
  client: OpenVikingClient;
  commits: () => Array<Record<string, unknown>>;
};

/** A server whose context estimate is read in turn from `contextTokens`: before the commit, after it, after a second one. */
function server(contextTokens: number[]): Fake {
  const commits: Array<Record<string, unknown>> = [];
  let reads = 0;
  const transport: HttpTransport = vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    const answer = (body: unknown) =>
      new Response(JSON.stringify({ status: "ok", result: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (path.endsWith("/commit")) {
      commits.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      return answer({ status: "ok", archived: true, archive_uri: "viking://archives/a1" });
    }
    if (path.endsWith("/context")) {
      const estimatedTokens = contextTokens[Math.min(reads, contextTokens.length - 1)];
      reads += 1;
      return answer({
        latest_archive_overview: "сводка",
        pre_archive_abstracts: [],
        messages: [],
        estimatedTokens,
        stats: { totalArchives: 1, includedArchives: 1, droppedArchives: 0, failedArchives: 0,
                 activeTokens: estimatedTokens, archiveTokens: 100 },
      });
    }
    if (/\/api\/v1\/sessions\/[^/]+$/.test(path)) {
      return answer({ pending_tokens: 90_000 });
    }
    return new Response(JSON.stringify({ status: "error", error: { code: "NOT_FOUND", message: path } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  });
  const client = new OpenVikingClient("http://127.0.0.1:1933", "ov-key", "main", 5_000, "", "", undefined, {
    transport,
  });
  return { client, commits: () => commits };
}

function engineOver(fake: Fake) {
  return createMemoryOpenVikingContextEngine({
    id: "openviking",
    name: "OpenViking",
    cfg: memoryOpenVikingConfigSchema.parse({
      baseUrl: "http://127.0.0.1:1933",
      autoRecall: false,
      commitKeepRecentCount: 20,
    }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    getClient: async () => fake.client,
    resolveAgentId: () => "main",
  });
}

async function compact(fake: Fake, compactionTarget: "budget" | "threshold" | undefined) {
  const engine = engineOver(fake);
  return await engine.compact?.({
    sessionId: "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3",
    sessionFile: "/tmp/compact.jsonl",
    tokenBudget: 240_000,
    ...(compactionTarget ? { compactionTarget } : {}),
  } as never);
}

describe("сжатие по просьбе шлюза", () => {
  it("автоматическое сжатие оставляет последние сообщения, сколько задано", async () => {
    const fake = server([250_000, 90_000]);
    const result = await compact(fake, "budget");
    expect(result?.ok).toBe(true);
    expect(fake.commits()).toEqual([{ keep_recent_count: 20 }]);
  });

  it("ручной /compact сворачивает всё, как и сжатие без пометки", async () => {
    const manual = server([250_000, 5_000]);
    await compact(manual, "threshold");
    expect(manual.commits()).toEqual([{}]);

    const unmarked = server([250_000, 5_000]);
    await compact(unmarked, undefined);
    expect(unmarked.commits()).toEqual([{}]);
  });

  it("хвост, который сам не влезает в бюджет, сворачивается вторым коммитом", async () => {
    const fake = server([300_000, 260_000, 5_000]);
    const result = await compact(fake, "budget");
    expect(result?.ok).toBe(true);
    expect(fake.commits()).toEqual([{ keep_recent_count: 20 }, {}]);
  });

  it("хвост, который влезает, второго коммита не вызывает", async () => {
    const fake = server([300_000, 239_000]);
    await compact(fake, "budget");
    expect(fake.commits()).toEqual([{ keep_recent_count: 20 }]);
  });
});
