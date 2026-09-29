import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, type OVMessage, type SessionContextResult } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";
import { assembleOpenVikingSession } from "../services/context-lifecycle-service.js";
import type { AgentMessage } from "../services/context-message-adapter.js";
import { estimateAgentMessagesTokens } from "../token-estimator.js";

/*
 * Сборка контекста, когда сервер Викинга не может дать свежий пересказ.
 *
 * Случай 28.09.2026: шторм 503 сорвал извлечение после коммита, сервер 0.4.12 при сорванном
 * новом архиве не отдаёт пересказ вовсе, и плагин отдал шлюзу всю живую переписку -- 1117
 * сообщений, 377 тысяч токенов. Такой запрос не проходит ни на одном ключе, и чат встаёт.
 *
 * Правило: нет свежего пересказа -- берётся пересказ последнего закрытого архива и всё, что
 * было после него, по порядку и без пропуска. Целиком переписка, которая больше бюджета, не
 * уходит никогда, по какой бы причине ответ сервера ни оказался негодным.
 *
 * Сервер здесь -- настоящий клиент плагина над транспортом, который отвечает так, как отвечает
 * сервер 0.4.12: конверт {status, result, error}, 404 и NOT_FOUND на сорванный архив.
 *
 * Время. В живой переписке у каждого сообщения своё. На сервер плагин шлёт сообщения хода с
 * ОДНИМ временем -- временем последнего сообщения хода (`pickLatestCreatedAt`), и сервер отдаёт
 * его как получил. Ход здесь -- пара: сообщение пользователя 2k и ответ 2k+1. Архив режется по
 * числу сообщений (`keep_recent_count`), а не по ходам, и может кончиться посреди хода. Поэтому
 * хвост начинается с начала того хода, на котором кончился архив: лишний ход в ответе стоит
 * токенов, пропущенное сообщение стоит нити разговора.
 */

const START = Date.UTC(2026, 8, 28, 8, 0, 0);
const PADDING = " слово".repeat(160);

function mark(i: number): string {
  return `[m${String(i).padStart(3, "0")}]`;
}

/** Живая переписка: user и assistant по очереди, у каждого сообщения своя метка и своё время. */
function liveTranscript(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: i % 2 === 0 ? `${mark(i)}${PADDING}` : [{ type: "text", text: `${mark(i)}${PADDING}` }],
    timestamp: START + i * 60_000,
  }));
}

/** Сообщение, как оно лежит на сервере: время -- не своё, а последнего сообщения своего хода. */
function ovMessage(i: number, role = i % 2 === 0 ? "user" : "assistant"): OVMessage {
  const lastOfTurn = i - (i % 2) + 1;
  return {
    id: `ov-${i}`,
    role,
    parts: [{ type: "text", text: `${mark(i)} на сервере` }],
    created_at: new Date(START + lastOfTurn * 60_000).toISOString(),
  };
}

type Shelf = {
  context?: Partial<SessionContextResult>;
  contextError?: { status: number; code: string; message: string };
  down?: boolean;
  archives?: Record<string, { overview: string; lastMessageIndex: number }>;
};

function server(shelf: Shelf) {
  const asked: string[] = [];
  const transport: HttpTransport = vi.fn(async (url) => {
    const path = new URL(url).pathname;
    asked.push(path);
    if (shelf.down) {
      throw new TypeError("fetch failed");
    }
    const answer = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/context")) {
      if (shelf.contextError) {
        const { status, code, message } = shelf.contextError;
        return answer(status, { status: "error", error: { code, message } });
      }
      return answer(200, {
        status: "ok",
        result: {
          latest_archive_overview: "",
          pre_archive_abstracts: [],
          messages: [],
          estimatedTokens: 0,
          stats: {
            totalArchives: 0, includedArchives: 0, droppedArchives: 0,
            failedArchives: 0, activeTokens: 0, archiveTokens: 0,
          },
          ...shelf.context,
        },
      });
    }
    const archive = /\/archives\/([^/]+)$/.exec(path);
    if (archive) {
      const found = shelf.archives?.[archive[1]];
      if (!found) {
        return answer(404, {
          status: "error",
          error: { code: "NOT_FOUND", message: `Session archive not found: ${archive[1]}` },
        });
      }
      return answer(200, {
        status: "ok",
        result: {
          archive_id: archive[1],
          abstract: "кратко",
          overview: found.overview,
          // Шесть последних сообщений архива, по порядку, до lastMessageIndex включительно.
          messages: Array.from({ length: 6 }, (_, k) => found.lastMessageIndex - 5 + k)
            .filter((i) => i >= 0)
            .map((i) => ovMessage(i)),
        },
      });
    }
    return answer(404, { status: "error", error: { code: "NOT_FOUND", message: `no route ${path}` } });
  });
  const client = new OpenVikingClient("http://127.0.0.1:1933", "ov-key", "main", 5_000, "", "", undefined, {
    transport,
  });
  return { client, asked };
}

function assemble(messages: AgentMessage[], tokenBudget: number, client: OpenVikingClient) {
  const seen: Array<{ stage: string; data: Record<string, unknown> }> = [];
  const warned: string[] = [];
  const result = assembleOpenVikingSession({
    sessionId: "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3",
    messages,
    tokenBudget,
    isMainAssemble: true,
    cfg: { autoRecall: false },
    getClient: async () => client,
    logger: { info: () => {}, warn: (line) => warned.push(line) },
    resolveAgentId: () => "main",
    isBypassedSession: () => false,
    diag: (stage, _session, data) => seen.push({ stage, data }),
    roughEstimate: estimateAgentMessagesTokens,
    messageDigest: () => [],
    extractAgentMessageText: () => "",
    hasAutoRecallBlock: () => false,
    prependRecallToLatestUserMessage: (list) => list,
  });
  return result.then((value) => ({
    value,
    warned,
    outcome: seen.filter((s) => s.stage === "assemble_result").at(-1)?.data ?? {},
  }));
}

/** Метки сообщений в том порядке, в каком они идут в ответе. */
function marksOf(messages: AgentMessage[]): string[] {
  return JSON.stringify(messages).match(/\[m\d{3}\]/g) ?? [];
}

const NO_SUMMARY = (total: number, failed: number, active: OVMessage[]): Partial<SessionContextResult> => ({
  latest_archive_overview: "",
  messages: active,
  stats: {
    totalArchives: total, includedArchives: 0, droppedArchives: 0,
    failedArchives: failed, activeTokens: 0, archiveTokens: 0,
  },
});

describe("сборка, когда сервер дал пересказ", () => {
  it("идёт как шла: пересказ и сообщения сервера, архивы не спрашиваются", async () => {
    const live = liveTranscript(60);
    const { client, asked } = server({
      context: {
        latest_archive_overview: "ПЕРЕСКАЗ-СВЕЖИЙ",
        messages: [ovMessage(58, "user"), ovMessage(59, "assistant")],
        stats: {
          totalArchives: 3, includedArchives: 0, droppedArchives: 3,
          failedArchives: 0, activeTokens: 10, archiveTokens: 5,
        },
      },
    });
    const { value, outcome } = await assemble(live, 12_000, client);

    expect(JSON.stringify(value.messages[0])).toContain("[Session History Summary]\\nПЕРЕСКАЗ-СВЕЖИЙ");
    expect(marksOf(value.messages)).toEqual([mark(58), mark(59)]);
    expect(JSON.stringify(value.messages)).toContain("на сервере");
    expect(value.systemPromptAddition).toContain("Session Context Guide");
    expect(outcome.passthrough).toBe(false);
    expect(outcome.recovered).toBeUndefined();
    expect(asked.filter((p) => p.includes("/archives/"))).toEqual([]);
  });
});

describe("сборка, когда свежего пересказа нет", () => {
  it("маленькую переписку отдаёт как есть, тем же массивом", async () => {
    const live = liveTranscript(10);
    const { client, asked } = server({ context: NO_SUMMARY(3, 1, [ovMessage(9)]) });
    const { value, outcome } = await assemble(live, 200_000, client);

    expect(value.messages).toBe(live);
    expect(outcome.passthrough).toBe(true);
    expect(outcome.reason).toBe("ov_msgs_fewer_than_input");
    expect(asked.filter((p) => p.includes("/archives/"))).toEqual([]);
  });

  it("большую собирает из прошлого пересказа и всего, что было после него, без пропуска и по порядку", async () => {
    const live = liveTranscript(60);
    const whole = estimateAgentMessagesTokens(live);
    const budget = 12_000;
    expect(whole).toBeGreaterThan(budget);
    const { client, asked } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(58), ovMessage(59, "assistant")]),
      // archive_003 сорван шторма ради: сервер его не отдаёт. archive_002 закрыт на сообщении 39.
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-39", lastMessageIndex: 39 } },
    });
    const { value, outcome, warned } = await assemble(live, budget, client);

    expect(JSON.stringify(value.messages[0])).toContain("[Session History Summary]\\nПЕРЕСКАЗ-ДО-39");
    // С начала хода, на котором кончился архив (38 и 39), и до конца.
    expect(marksOf(value.messages)).toEqual(Array.from({ length: 22 }, (_, k) => mark(38 + k)));
    expect(JSON.stringify(value.messages)).not.toContain("на сервере");
    expect(value.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(value.estimatedTokens).toBe(
      estimateAgentMessagesTokens(value.messages) + Number(outcome.instructionTokens),
    );
    expect(value.systemPromptAddition).toContain("Session Context Guide");
    expect(asked.filter((p) => p.includes("/archives/")).map((p) => p.split("/").at(-1)))
      .toEqual(["archive_003", "archive_002"]);
    expect(outcome).toMatchObject({
      passthrough: false, recovered: true, reason: "ov_msgs_fewer_than_input",
      archiveId: "archive_002", boundaryFound: true, tailMessages: 22, droppedMessages: 0,
    });
    expect(outcome.boundary).toEqual({
      archiveTurns: 3,
      lookedFor: new Date(START + 37 * 60_000).toISOString(),
      liveMessages: 60,
      liveWithTime: 60,
      timeKinds: { number: 60 },
      nearestMs: 0,
      nearestIndex: 37,
      nearestRole: "assistant",
    });
    expect(warned.join("\n")).toContain("no fresh summary");
  });

  it("архив кончился посреди хода: ответ, который в архив не попал, не теряется", async () => {
    const live = liveTranscript(60);
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59)]),
      // Сообщение пользователя 38 в архиве, ответ 39 остался снаружи; время у обоих -- хода.
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-38", lastMessageIndex: 38 } },
    });
    const { value, outcome } = await assemble(live, 12_000, client);

    expect(marksOf(value.messages)).toEqual(Array.from({ length: 22 }, (_, k) => mark(38 + k)));
    expect(outcome).toMatchObject({ recovered: true, boundaryFound: true, tailMessages: 22 });
  });

  it("сообщение, написанное пока модель ещё отвечала, не теряется, хотя время у него раньше", async () => {
    const live = liveTranscript(60);
    // Пользователь отправил сообщение 40, пока шёл ответ 39: в переписке оно позже, по времени раньше.
    live[40] = { ...live[40], timestamp: START + 38 * 60_000 + 5_000 };
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59)]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-39", lastMessageIndex: 39 } },
    });
    const { value } = await assemble(live, 12_000, client);

    expect(marksOf(value.messages)).toEqual(Array.from({ length: 22 }, (_, k) => mark(38 + k)));
  });

  it("в архиве виден один ход: границу не угадывает, берёт по бюджету", async () => {
    const live = liveTranscript(60);
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59)]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ОДИН-ХОД", lastMessageIndex: 1 } },
    });
    const { value, outcome } = await assemble(live, 12_000, client);

    expect(JSON.stringify(value.messages[0])).toContain("ПЕРЕСКАЗ-ОДИН-ХОД");
    expect(marksOf(value.messages).at(-1)).toBe(mark(59));
    expect(value.estimatedTokens).toBeLessThanOrEqual(12_000);
    expect(outcome).toMatchObject({ recovered: true, boundaryFound: false, tailMessages: 60 });
  });

  it("то, что не влезает в бюджет, режет со старого конца и говорит, сколько срезал", async () => {
    const live = liveTranscript(60);
    const budget = 12_000;
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-9", lastMessageIndex: 9 } },
    });
    const { value, outcome, warned } = await assemble(live, budget, client);

    const kept = marksOf(value.messages);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(50);
    // Остался хвост подряд, до самого последнего сообщения.
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, k) => mark(60 - kept.length + k)));
    expect(value.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(JSON.stringify(value.messages[0])).toContain("ПЕРЕСКАЗ-ДО-9");
    expect(outcome).toMatchObject({ recovered: true, tailMessages: 52, droppedMessages: 52 - kept.length });
    expect(warned.join("\n")).toContain(`dropped ${52 - kept.length}`);
  });

  it("закрытого архива нет: хвост в пределах бюджета, начинается с сообщения пользователя", async () => {
    const live = liveTranscript(60);
    const budget = 12_000;
    const { client, asked } = server({ context: NO_SUMMARY(2, 1, [ovMessage(59, "assistant")]), archives: {} });
    const { value, outcome } = await assemble(live, budget, client);

    expect(JSON.stringify(value.messages)).not.toContain("[Session History Summary]");
    const kept = marksOf(value.messages);
    expect(kept.at(-1)).toBe(mark(59));
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, k) => mark(60 - kept.length + k)));
    expect(value.messages[0].role).toBe("user");
    expect(value.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(value.systemPromptAddition).toBeUndefined();
    expect(asked.filter((p) => p.includes("/archives/")).map((p) => p.split("/").at(-1)))
      .toEqual(["archive_002", "archive_001"]);
    expect(outcome).toMatchObject({ recovered: true, archiveId: null });
  });

  it("ищет закрытый архив не дольше восьми шагов назад", async () => {
    const live = liveTranscript(60);
    const { client, asked } = server({
      context: NO_SUMMARY(20, 1, [ovMessage(59, "assistant")]),
      archives: { archive_005: { overview: "СЛИШКОМ-ДАЛЕКО", lastMessageIndex: 9 } },
    });
    const { value, outcome } = await assemble(live, 12_000, client);

    expect(asked.filter((p) => p.includes("/archives/"))).toHaveLength(8);
    expect(JSON.stringify(value.messages)).not.toContain("СЛИШКОМ-ДАЛЕКО");
    expect(outcome).toMatchObject({ recovered: true, archiveId: null });
  });

  it("время в живой переписке не читается: хвост по бюджету, пересказ на месте", async () => {
    const live = liveTranscript(60).map(({ timestamp: _gone, ...rest }) => rest);
    const budget = 12_000;
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-39", lastMessageIndex: 39 } },
    });
    const { value, outcome } = await assemble(live, budget, client);

    expect(JSON.stringify(value.messages[0])).toContain("ПЕРЕСКАЗ-ДО-39");
    const kept = marksOf(value.messages);
    expect(kept.at(-1)).toBe(mark(59));
    expect(kept.length).toBeGreaterThan(20);        // граница неизвестна -- берём больше, а не меньше
    expect(value.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(outcome).toMatchObject({ recovered: true, archiveId: "archive_002", boundaryFound: false });
    expect(outcome.boundary).toEqual({
      archiveTurns: 3,
      lookedFor: new Date(START + 37 * 60_000).toISOString(),
      liveMessages: 60,
      liveWithTime: 0,
      timeKinds: { undefined: 60 },
      nearestMs: null,
      nearestIndex: null,
      nearestRole: null,
    });
  });

  it("время в живой переписке чуть другое: говорит, на сколько и у какого сообщения", async () => {
    const live = liveTranscript(60).map((m, i) => ({ ...m, timestamp: START + i * 60_000 + 7 }));
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-39", lastMessageIndex: 39 } },
    });
    const { outcome, warned } = await assemble(live, 12_000, client);

    expect(outcome).toMatchObject({ recovered: true, boundaryFound: false });
    expect(outcome.boundary).toMatchObject({
      liveWithTime: 60, timeKinds: { number: 60 }, nearestMs: 7, nearestIndex: 37, nearestRole: "assistant",
    });
    expect(JSON.stringify(outcome.boundary)).not.toContain("[m");
    expect(warned.join("\n")).toContain("nearest live message is 7 ms off");
  });

  it("хвост не начинается с ответа инструмента, у которого отрезан вызов", async () => {
    const live = liveTranscript(60);
    // Вызов -- последнее сообщение хода перед тем, на котором кончился архив; ответ инструмента
    // открывает хвост.
    live[37] = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.md" } }],
      timestamp: START + 37 * 60_000,
    };
    live[38] = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: `${mark(38)} ответ инструмента` }],
      timestamp: START + 38 * 60_000,
    } as AgentMessage;
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-39", lastMessageIndex: 39 } },
    });
    const { value } = await assemble(live, 12_000, client);

    expect(value.messages.some((m) => m.role === "toolResult")).toBe(false);
    expect(marksOf(value.messages)).toEqual(Array.from({ length: 21 }, (_, k) => mark(39 + k)));
  });

  it("живую переписку не меняет", async () => {
    const live = liveTranscript(60);
    live[41] = { role: "assistant", content: `${mark(41)} строкой, не блоками`, timestamp: START + 41 * 60_000 };
    const before = structuredClone(live);
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-39", lastMessageIndex: 39 } },
    });
    await assemble(live, 12_000, client);

    expect(live).toEqual(before);
  });
});

describe("сборка, когда ответ сервера негоден по другой причине", () => {
  const budget = 12_000;

  it("сервер не отвечает: большая переписка целиком не уходит", async () => {
    const live = liveTranscript(60);
    const { client } = server({ down: true });
    const { value, outcome, warned } = await assemble(live, budget, client);

    expect(value.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(marksOf(value.messages).at(-1)).toBe(mark(59));
    expect(marksOf(value.messages).length).toBeLessThan(60);
    expect(value.messages[0].role).toBe("user");
    expect(outcome).toMatchObject({ recovered: true, reason: "assemble_error", archiveId: null });
    expect(warned.join("\n")).toContain("assemble failed");
  });

  it("сервер не отвечает, а переписка маленькая: как раньше, тем же массивом", async () => {
    const live = liveTranscript(10);
    const { client } = server({ down: true });
    const { value } = await assemble(live, 200_000, client);

    expect(value.messages).toBe(live);
  });

  it("сессии на сервере нет: большая переписка целиком не уходит", async () => {
    const live = liveTranscript(60);
    const { client } = server({
      contextError: { status: 404, code: "NOT_FOUND", message: "Session not found: 9478e347" },
    });
    const { value, outcome } = await assemble(live, budget, client);

    expect(value.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(marksOf(value.messages).at(-1)).toBe(mark(59));
    expect(outcome).toMatchObject({ recovered: true, reason: "session_not_found", archiveId: null });
  });

  it("на сервере пусто: большая переписка целиком не уходит", async () => {
    const live = liveTranscript(60);
    const { client } = server({ context: NO_SUMMARY(0, 0, []) });
    const { value, outcome } = await assemble(live, budget, client);

    expect(value.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(marksOf(value.messages).at(-1)).toBe(mark(59));
    expect(outcome).toMatchObject({ recovered: true, reason: "no_ov_data", archiveId: null });
  });
});

describe("то же через движок, как его зовёт шлюз", () => {
  it("большая переписка без свежего пересказа собирается из прошлого пересказа и хвоста", async () => {
    const live = liveTranscript(60);
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-39", lastMessageIndex: 39 } },
    });
    const engine = createMemoryOpenVikingContextEngine({
      id: "openviking",
      name: "OpenViking",
      cfg: memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", autoRecall: false }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      getClient: async () => client,
      resolveAgentId: () => "main",
    });
    const value = await engine.assemble({
      sessionId: "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3",
      messages: live,
      tokenBudget: 12_000,
      availableTools: new Set<string>(),
    } as never);

    expect(JSON.stringify(value.messages[0])).toContain("ПЕРЕСКАЗ-ДО-39");
    expect(marksOf(value.messages as AgentMessage[])).toEqual(Array.from({ length: 22 }, (_, k) => mark(38 + k)));
    expect(value.estimatedTokens).toBeLessThanOrEqual(12_000);
  });
});
