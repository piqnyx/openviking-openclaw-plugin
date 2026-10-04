import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";

/*
 * Когда Викинг сворачивает накопленное в сводку.
 *
 * Порог задаётся числом токенов (`commitTokenThreshold`): накопилось не меньше -- сворачиваем.
 * Ход попадает в Викинг двумя путями, и оба решают по одному и тому же числу: живой путь
 * (afterTurn) внутри хода, после результатов инструментов, и запись хода целиком (commitTurn)
 * после хода, через очередь шлюза. Бюджет контекста модели для порога не нужен: шлюз передаёт
 * его только живому пути, а запись хода проходит каждый ход.
 *
 * Случай 02.10.2026: порог был долей от бюджета, записи хода бюджет не достаётся, и она считала
 * его от запасных 128 000 -- сводки делались при 25 600 вместо настроенных 48 000.
 */

const SESSION_BASE = "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3";

type FakeServer = {
  client: OpenVikingClient;
  recorded: () => number;
  commits: () => number;
};

function server(pendingTokens: number): FakeServer {
  const asked: string[] = [];
  const transport: HttpTransport = vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    asked.push(`${init?.method ?? "GET"} ${path}`);
    const answer = (body: unknown) =>
      new Response(JSON.stringify({ status: "ok", result: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (path.endsWith("/messages")) {
      return answer({ session_id: "s" });
    }
    if (path.endsWith("/commit")) {
      return answer({ status: "ok", archived: true, task_id: "task-1" });
    }
    if (/\/api\/v1\/sessions\/[^/]+$/.test(path)) {
      return answer({ pending_tokens: pendingTokens });
    }
    return new Response(JSON.stringify({ status: "error", error: { code: "NOT_FOUND", message: path } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  });
  const client = new OpenVikingClient("http://127.0.0.1:1933", "ov-key", "main", 5_000, "", "", undefined, {
    transport,
  });
  return {
    client,
    recorded: () => asked.filter((entry) => entry.startsWith("POST ") && entry.endsWith("/messages")).length,
    commits: () => asked.filter((entry) => entry.startsWith("POST ") && entry.endsWith("/commit")).length,
  };
}

function engineOver(fake: FakeServer, commitTokenThreshold: number) {
  return createMemoryOpenVikingContextEngine({
    id: "openviking",
    name: "OpenViking",
    cfg: memoryOpenVikingConfigSchema.parse({
      baseUrl: "http://127.0.0.1:1933",
      autoRecall: false,
      commitTokenThreshold,
    }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    getClient: async () => fake.client,
    resolveAgentId: () => "main",
  });
}

/** Один ход: вопрос и ответ; содержимое уникально, чтобы отпечатки ходов не совпадали между проверками. */
function turn(tag: string) {
  return [
    { role: "user", content: `вопрос ${tag}`, timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: `ответ ${tag}` }], timestamp: 2 },
  ];
}

async function recordTurn(fake: FakeServer, threshold: number, tag: string) {
  const engine = engineOver(fake, threshold);
  const result = await engine.commitTurn?.({
    advancementKey: `adv-${tag}`,
    messages: turn(tag) as never,
    prePromptMessageCount: 0,
    sessionId: `${SESSION_BASE}-${tag}`,
  });
  expect(result?.status).toBe("committed");
  expect(fake.recorded()).toBe(2);
}

async function liveTurn(fake: FakeServer, threshold: number, tag: string, tokenBudget?: number) {
  const engine = engineOver(fake, threshold);
  await engine.afterTurn?.({
    sessionId: `${SESSION_BASE}-${tag}`,
    sessionFile: `/tmp/${tag}.jsonl`,
    messages: turn(tag) as never,
    prePromptMessageCount: 0,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
  });
  expect(fake.recorded()).toBe(2);
}

describe("порог сводки в токенах", () => {
  it("запись хода в конце сворачивает от порога, бюджет ей не нужен", async () => {
    const below = server(49_999);
    await recordTurn(below, 50_000, "record-below");
    expect(below.commits()).toBe(0);

    const reached = server(50_000);
    await recordTurn(reached, 50_000, "record-reached");
    expect(reached.commits()).toBe(1);
  });

  it("живой путь сворачивает от того же числа, какой бы бюджет ни дал шлюз", async () => {
    const below = server(49_999);
    await liveTurn(below, 50_000, "live-below", 240_000);
    expect(below.commits()).toBe(0);

    const reached = server(50_000);
    await liveTurn(reached, 50_000, "live-reached", 240_000);
    expect(reached.commits()).toBe(1);

    const smallBudget = server(50_000);
    await liveTurn(smallBudget, 50_000, "live-small-budget", 128_000);
    expect(smallBudget.commits()).toBe(1);

    const noBudget = server(50_000);
    await liveTurn(noBudget, 50_000, "live-no-budget");
    expect(noBudget.commits()).toBe(1);
  });

  it("ноль означает сворачивать каждый ход", async () => {
    const fake = server(1);
    await recordTurn(fake, 0, "record-zero");
    expect(fake.commits()).toBe(1);
  });
});

/*
 * Потолок общего объёма (Вит, 04.10.2026). Порог ожидающих не видит хвоста из последних
 * сообщений, а шлюз режет окно по всей переписке: тяжёлый хвост доводил до резки раньше
 * сводки. Оба пути записи получают всю переписку от шлюза, и её размер в оценке плагина
 * сравнивается с потолком: достигли -- сводка и под порогом ожидающих, с теми же
 * оставленными последними сообщениями. Сводить нечего (ожидающих нет) -- потолок молчит.
 */
function engineWithCeiling(fake: FakeServer, commitContextCeiling: number) {
  return createMemoryOpenVikingContextEngine({
    id: "openviking",
    name: "OpenViking",
    cfg: memoryOpenVikingConfigSchema.parse({
      baseUrl: "http://127.0.0.1:1933",
      autoRecall: false,
      commitTokenThreshold: 131_072,
      commitContextCeiling,
    }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    getClient: async () => fake.client,
    resolveAgentId: () => "main",
  });
}

/** A turn whose transcript is well over a small ceiling in the plugin's estimate. */
function heavyTurn(tag: string) {
  return [
    { role: "user", content: `вопрос ${tag} ` + "слово ".repeat(600), timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: `ответ ${tag}` }], timestamp: 2 },
  ];
}

describe("потолок общего объёма переписки", () => {
  it("над потолком запись хода сворачивает и под порогом ожидающих", async () => {
    const fake = server(1_000);
    const engine = engineWithCeiling(fake, 500);
    const result = await engine.commitTurn?.({
      advancementKey: "adv-ceiling-record",
      messages: heavyTurn("ceiling-record") as never,
      prePromptMessageCount: 0,
      sessionId: `${SESSION_BASE}-ceiling-record`,
    });
    expect(result?.status).toBe("committed");
    expect(fake.commits()).toBe(1);
  });

  it("живой путь решает так же", async () => {
    const fake = server(1_000);
    const engine = engineWithCeiling(fake, 500);
    await engine.afterTurn?.({
      sessionId: `${SESSION_BASE}-ceiling-live`,
      sessionFile: "/tmp/ceiling-live.jsonl",
      messages: heavyTurn("ceiling-live") as never,
      prePromptMessageCount: 0,
      tokenBudget: 240_000,
    });
    expect(fake.commits()).toBe(1);
  });

  it("под потолком и под порогом -- без сводки", async () => {
    const fake = server(1_000);
    const engine = engineWithCeiling(fake, 1_000_000);
    await engine.commitTurn?.({
      advancementKey: "adv-ceiling-under",
      messages: heavyTurn("ceiling-under") as never,
      prePromptMessageCount: 0,
      sessionId: `${SESSION_BASE}-ceiling-under`,
    });
    expect(fake.commits()).toBe(0);
  });

  it("ноль -- потолка нет, решает один порог ожидающих", async () => {
    const fake = server(1_000);
    const engine = engineWithCeiling(fake, 0);
    await engine.commitTurn?.({
      advancementKey: "adv-ceiling-off",
      messages: heavyTurn("ceiling-off") as never,
      prePromptMessageCount: 0,
      sessionId: `${SESSION_BASE}-ceiling-off`,
    });
    expect(fake.commits()).toBe(0);
  });

  it("над потолком, но сводить нечего -- потолок молчит", async () => {
    const fake = server(0);
    const engine = engineWithCeiling(fake, 500);
    await engine.commitTurn?.({
      advancementKey: "adv-ceiling-nothing",
      messages: heavyTurn("ceiling-nothing") as never,
      prePromptMessageCount: 0,
      sessionId: `${SESSION_BASE}-ceiling-nothing`,
    });
    expect(fake.commits()).toBe(0);
  });
});
