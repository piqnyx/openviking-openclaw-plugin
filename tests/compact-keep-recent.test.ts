import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";

/*
 * Сводка по просьбе шлюза (Вит, 04.10.2026).
 *
 * Шлюз зовёт compact движка двумя способами и помечает их: автоматическое сжатие
 * перед ходом, когда запрос подошёл к краю окна, идёт с пометкой "budget"; ручной
 * /compact -- с пометкой "threshold". Раньше compact сворачивал всё, и после
 * автоматического сжатия в окне оставалась одна сводка без живых сообщений.
 * Теперь автоматическое сжатие оставляет столько последних сообщений, сколько
 * задано в commitKeepRecentCount, как и сводка самого Викинга по порогу. Ручной
 * /compact сворачивает всё, как было.
 *
 * Если с сохранёнными последними сообщениями сводить нечего (например, Викинг
 * только что сам сделал сводку, а шлюз ещё не видит, что запрос стал меньше),
 * плагин отвечает шлюзу «уже сжато». Шлюз считает безвредными только такие
 * ответы («already compacted», «below threshold»); на любой другой он роняет ход.
 * Сворачивать в этом случае живые сообщения нельзя: модель осталась бы с одной
 * сводкой.
 */

type Fake = {
  client: OpenVikingClient;
  commits: () => Array<Record<string, unknown>>;
};

function server(archived: boolean): Fake {
  const commits: Array<Record<string, unknown>> = [];
  const transport: HttpTransport = vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    const answer = (body: unknown) =>
      new Response(JSON.stringify({ status: "ok", result: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (path.endsWith("/commit")) {
      commits.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      return answer(
        archived
          ? { status: "completed", archived: true, archive_uri: "viking://session/archives/archive_007" }
          : { status: "completed", archived: false },
      );
    }
    if (path.endsWith("/context")) {
      return answer({
        latest_archive_overview: "сводка",
        pre_archive_abstracts: [],
        messages: [],
        estimatedTokens: 5_000,
        stats: {
          totalArchives: 1,
          includedArchives: 1,
          droppedArchives: 0,
          failedArchives: 0,
          activeTokens: 4_000,
          archiveTokens: 1_000,
        },
      });
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

async function compact(fake: Fake, compactionTarget: "budget" | "threshold" | undefined) {
  const engine = createMemoryOpenVikingContextEngine({
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
  return await engine.compact?.({
    sessionId: "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3",
    sessionFile: "/tmp/compact.jsonl",
    tokenBudget: 249_000,
    currentTokenCount: 226_000,
    ...(compactionTarget ? { compactionTarget } : {}),
  } as never);
}

describe("сводка по просьбе шлюза", () => {
  it("автоматическое сжатие оставляет последние сообщения, сколько задано", async () => {
    const fake = server(true);
    const result = await compact(fake, "budget");
    expect(fake.commits()).toEqual([{ keep_recent_count: 20 }]);
    expect(result?.ok).toBe(true);
    expect(result?.compacted).toBe(true);
  });

  it("ручной /compact и сжатие без пометки сворачивают всё, как раньше", async () => {
    const manual = server(true);
    await compact(manual, "threshold");
    expect(manual.commits()).toEqual([{}]);

    const unmarked = server(true);
    await compact(unmarked, undefined);
    expect(unmarked.commits()).toEqual([{}]);
  });

  it("сводить нечего: ответ «уже сжато», живые сообщения не трогаются", async () => {
    const fake = server(false);
    const result = await compact(fake, "budget");
    // Один коммит, с сохранёнными сообщениями; второго, сворачивающего всё, нет.
    expect(fake.commits()).toEqual([{ keep_recent_count: 20 }]);
    expect(result?.ok).toBe(true);
    expect(result?.compacted).toBe(false);
    // Шлюз пропускает ход только при таких словах; на другие он роняет ход.
    expect(String(result?.reason)).toMatch(/already compacted/i);
  });

  it("ручной /compact при пустой сессии отвечает как раньше", async () => {
    const fake = server(false);
    const result = await compact(fake, "threshold");
    expect(fake.commits()).toEqual([{}]);
    expect(result?.ok).toBe(true);
    expect(result?.compacted).toBe(false);
    expect(result?.reason).toBe("commit_no_archive");
  });
});
