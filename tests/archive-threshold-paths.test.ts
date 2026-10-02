import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";

/*
 * Когда Викинг решает «пора сворачивать накопленное в сводку».
 *
 * Ход попадает в Викинг двумя путями. Живой путь (afterTurn) работает внутри хода, и шлюз
 * передаёт ему бюджет контекста модели; порог сводки -- доля от этого бюджета
 * (`commitTokenThresholdRatio`). Долговечная запись хода (commitTurn) идёт через очередь шлюза
 * после хода; по контракту шлюза бюджета в этом вызове нет, и быть не должно: это запись
 * «что было сказано», а не работа с моделью.
 *
 * Случай 02.10.2026: запись хода тоже считала порог, подставляя запасные 128 000 вместо
 * бюджета, и сводки делались при 25 600 накопленных токенов вместо настроенных 48 000.
 *
 * Правило: решение о сводке принимает только живой путь, от бюджета, который дал шлюз.
 * Запись хода только записывает.
 */

const SESSION_BASE = "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3";

type FakeServer = {
  client: OpenVikingClient;
  recorded: () => number;
  commits: () => number;
  setPendingTokens: (tokens: number) => void;
};

function server(pendingTokens: number): FakeServer {
  let pending = pendingTokens;
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
      return answer({ pending_tokens: pending });
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
    setPendingTokens: (tokens) => {
      pending = tokens;
    },
  };
}

function engineOver(fake: FakeServer) {
  return createMemoryOpenVikingContextEngine({
    id: "openviking",
    name: "OpenViking",
    cfg: memoryOpenVikingConfigSchema.parse({
      baseUrl: "http://127.0.0.1:1933",
      autoRecall: false,
      commitTokenThresholdRatio: 0.2,
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

describe("кто решает про сводку", () => {
  it("запись хода в конце (commitTurn) только записывает: сводку не запрашивает ни при каком накоплении", async () => {
    const fake = server(1_000_000);
    const engine = engineOver(fake);

    const result = await engine.commitTurn?.({
      advancementKey: "adv-record",
      messages: turn("record") as never,
      prePromptMessageCount: 0,
      sessionId: `${SESSION_BASE}-record`,
    });

    expect(result?.status).toBe("committed");
    expect(fake.recorded()).toBe(2);
    expect(fake.commits()).toBe(0);
  });

  it("живой путь (afterTurn) считает порог от бюджета, который дал шлюз", async () => {
    const below = server(31_728);
    await engineOver(below).afterTurn?.({
      sessionId: `${SESSION_BASE}-live-below`,
      sessionFile: "/tmp/live-below.jsonl",
      messages: turn("live-below") as never,
      prePromptMessageCount: 0,
      tokenBudget: 240_000,
    });
    expect(below.recorded()).toBe(2);
    expect(below.commits()).toBe(0);

    const reached = server(48_000);
    await engineOver(reached).afterTurn?.({
      sessionId: `${SESSION_BASE}-live-reached`,
      sessionFile: "/tmp/live-reached.jsonl",
      messages: turn("live-reached") as never,
      prePromptMessageCount: 0,
      tokenBudget: 240_000,
    });
    expect(reached.recorded()).toBe(2);
    expect(reached.commits()).toBe(1);
  });

  it("накопленное записью хода в конце увидит живой путь следующего хода", async () => {
    const fake = server(10_000);
    const engine = engineOver(fake);
    const sessionId = `${SESSION_BASE}-handover`;

    await engine.commitTurn?.({
      advancementKey: "adv-handover",
      messages: turn("handover-1") as never,
      prePromptMessageCount: 0,
      sessionId,
    });
    fake.setPendingTokens(48_000);
    expect(fake.commits()).toBe(0);

    await engine.afterTurn?.({
      sessionId,
      sessionFile: "/tmp/handover.jsonl",
      messages: [...turn("handover-1"), ...turn("handover-2")] as never,
      prePromptMessageCount: 2,
      tokenBudget: 240_000,
    });

    expect(fake.recorded()).toBe(4);
    expect(fake.commits()).toBe(1);
  });
});
