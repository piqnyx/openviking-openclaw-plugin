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
 *
 * Что не влезает (PLAN-gorizont 4б, 07.10): хвост режется не по оценке знаков под бюджет шлюза,
 * а по весу ручки прокси -- живая часть окна не тяжелее K, целыми ходами, не меньше планки;
 * переписка не длиннее планки или не тяжелее K целиком идёт как есть. Ручка здесь считает знаки
 * содержимого: сообщение переписки весит около 966, шестьдесят -- около 58 000, двадцать два --
 * около 21 250; K в этих проверках 30 000, чтобы целая переписка не проходила как есть, а хвост
 * с границы архива помещался. Без ручки режет одна планка, с предупреждением.
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
  /** `strayTurns`: ходы (по номеру последнего сообщения), чьё время на сервере не совпадает ни с чем. */
  archives?: Record<string, { overview: string; lastMessageIndex: number; strayTurns?: number[] }>;
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
            .map((i) => {
              const message = ovMessage(i);
              const lastOfTurn = i - (i % 2) + 1;
              return found.strayTurns?.includes(lastOfTurn)
                ? { ...message, created_at: new Date(START + lastOfTurn * 60_000 - 5_838).toISOString() }
                : message;
            }),
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

/** Ручка: вес тела -- сумма знаков содержимого. */
function charsHandle() {
  return {
    url: "http://127.0.0.1:8787/price",
    price: async (body: Record<string, unknown>) => {
      const messages = (body as { messages: Array<{ content: unknown }> }).messages;
      const charge = messages.reduce(
        (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
        0,
      );
      return { model: "m", charge, ours: charge, google: null, surcharge: 0, ceiling: 249_000, fits: true };
    },
  };
}

type Cut = {
  keepRecentTokens?: number;
  keepRecentFloor?: number;
  handle?: boolean | "silent";
  holdForSummarySeconds?: number;
  /** «Догнать» шло и не дописало (запись встала). */
  catchUp?: "stopped";
  /** PLAN-krug 7в.5: вид истории шлюза, который движок привязывает к ручке. */
  historyForModel?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
};

/** Весы, которые молчат: вердикта нет ни на одно тело (шторм). */
function silentHandle() {
  return { url: "http://127.0.0.1:8787/price", price: async () => null };
}

function assemble(messages: AgentMessage[], tokenBudget: number, client: OpenVikingClient, cut: Cut = {}) {
  const seen: Array<{ stage: string; data: Record<string, unknown> }> = [];
  const warned: string[] = [];
  const result = assembleOpenVikingSession({
    sessionId: "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3",
    messages,
    tokenBudget,
    isMainAssemble: true,
    cfg: {
      autoRecall: false,
      keepRecentTokens: cut.keepRecentTokens ?? 30_000,
      keepRecentFloor: cut.keepRecentFloor ?? 20,
      ...(cut.holdForSummarySeconds !== undefined ? { holdForSummarySeconds: cut.holdForSummarySeconds } : {}),
    },
    ...(cut.handle === false
      ? {}
      : {
          priceHandle: {
            ...(cut.handle === "silent" ? silentHandle() : charsHandle()),
            ...(cut.historyForModel ? { historyForModel: cut.historyForModel } : {}),
          },
        }),
    ...(cut.catchUp === "stopped"
      ? {
          catchUp: async () => ({ kind: "stopped" as const, written: 0, error: "storage busy" }),
          runtimeContext: {
            readSessionTranscript: {
              readVisiblePage: async () => ({ kind: "page", cursor: "-1", rows: [], hasMore: false }),
              selectModelVisible: (rows: unknown[]) => rows,
            },
          },
        }
      : {}),
    runtimeSettings: { model: { resolved: "gemini-3.5-flash-lite", requested: null } },
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

  // PLAN-krug 7в.6: the gateway stamps every user message by its `timestamp` (attempt-llm-boundary.ts);
  // a window message from Viking carries the time it was written with.
  it("сообщения окна несут время своей записи; нечитаемое время -- без поля", async () => {
    const live = liveTranscript(62);
    const unreadable = { ...ovMessage(60, "user"), created_at: "не время" };
    const { client } = server({
      context: {
        latest_archive_overview: "ПЕРЕСКАЗ-СВЕЖИЙ",
        messages: [ovMessage(57, "assistant"), ovMessage(58, "user"), ovMessage(59, "assistant"), unreadable],
        stats: {
          totalArchives: 3, includedArchives: 0, droppedArchives: 3,
          failedArchives: 0, activeTokens: 10, archiveTokens: 5,
        },
      },
    });
    const { value } = await assemble(live, 12_000, client);

    const carrying = (i: number) => value.messages.find((message) => JSON.stringify(message.content).includes(mark(i)));
    expect(carrying(57)?.timestamp).toBe(Date.parse(ovMessage(57).created_at));
    expect(carrying(58)?.timestamp).toBe(Date.parse(ovMessage(58).created_at));
    expect(carrying(59)?.timestamp).toBe(Date.parse(ovMessage(59).created_at));
    expect(carrying(60)).toBeDefined();
    expect(carrying(60)).not.toHaveProperty("timestamp");
  });
});

// PLAN-krug 7в.2: the path is chosen by what the server says, not by counting messages of two forms.
describe("путь окна по фактам сервера (PLAN-krug 7в.2)", () => {
  it("пересказ старшего архива стоит, а новейший ждёт пересказа после выключенного удержания -- запасной путь", async () => {
    const live = liveTranscript(60);
    const { client } = server({
      context: {
        latest_archive_overview: "ПЕРЕСКАЗ-СТАРЫЙ",
        // The newest archive's messages come raw until its summary stands.
        messages: [ovMessage(40), ovMessage(41, "assistant"), ovMessage(58), ovMessage(59, "assistant")],
        stats: {
          totalArchives: 3, includedArchives: 1, droppedArchives: 1,
          failedArchives: 0, activeTokens: 10, archiveTokens: 5, unsummarizedArchives: 1,
        },
      },
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-СТАРЫЙ", lastMessageIndex: 39 } },
    });
    const { outcome } = await assemble(live, 12_000, client, { holdForSummarySeconds: 0 });

    // PLAN-krug 7в.7а: the closed archive found is the one the answer stands on -- its summary and its boundary.
    expect(outcome).toMatchObject({
      recovered: true, reason: "no_fresh_summary", summaryFrom: "archive", archiveId: "archive_002",
    });
  });

  it("без читателя шлюза, архивов нет, у Викинга сообщений меньше -- проверка счёта как была", async () => {
    const live = liveTranscript(10);
    const { client } = server({
      context: {
        latest_archive_overview: "",
        messages: [ovMessage(9)],
        stats: {
          totalArchives: 0, includedArchives: 0, droppedArchives: 0,
          failedArchives: 0, activeTokens: 1, archiveTokens: 0, unsummarizedArchives: 0,
        },
      },
    });
    const { value, outcome } = await assemble(live, 200_000, client);

    expect(value.messages).toBe(live);
    expect(outcome.reason).toBe("ov_msgs_fewer_than_input");
  });
});

// PLAN-krug 7в.7а: the server's answer stands on the summary of the archive its walk stopped at -- a closed one,
// or one failed or still at work with its summary written whole (PLAN-gorizont 3г, 3е) -- while only closed
// archives are handed out one by one. The fallback path keeps the newest summary in hand.
describe("запасной путь и сводка, на которой стоит ответ сервера (PLAN-krug 7в.7а)", () => {
  // Сводка стоит у сорванного архива (3г) -- archive_002; перед ним закрытый archive_001, кончился на 39.
  const standingOn3g = (waiting: number): Partial<SessionContextResult> => ({
    latest_archive_overview: "ПЕРЕСКАЗ-3Г",
    messages: [ovMessage(48), ovMessage(49, "assistant"), ovMessage(58), ovMessage(59, "assistant")],
    stats: {
      totalArchives: 2 + waiting, includedArchives: 1, droppedArchives: 0,
      failedArchives: 1, activeTokens: 10, archiveTokens: 5, unsummarizedArchives: waiting,
    },
  });

  it.each([
    {
      trigger: "новейший ждёт сводки, удержание выключено",
      waiting: 1,
      cut: {},
      reason: "no_fresh_summary",
      probes: ["archive_003", "archive_002", "archive_001"],
    },
    {
      trigger: "«догнать» не дописало",
      waiting: 0,
      cut: { catchUp: "stopped" as const },
      reason: "catch_up_stopped",
      probes: ["archive_002", "archive_001"],
    },
  ])("$trigger: сводка из ответа, хвост с границы старшего закрытого", async ({ waiting, cut, reason, probes }) => {
    const live = liveTranscript(60);
    const { client, asked } = server({
      context: standingOn3g(waiting),
      archives: { archive_001: { overview: "ПЕРЕСКАЗ-СТАРШИЙ", lastMessageIndex: 39 } },
    });
    const { value, outcome } = await assemble(live, 12_000, client, { holdForSummarySeconds: 0, ...cut });

    expect(JSON.stringify(value.messages[0])).toContain("[Session History Summary]\\nПЕРЕСКАЗ-3Г");
    expect(JSON.stringify(value.messages)).not.toContain("ПЕРЕСКАЗ-СТАРШИЙ");
    // С начала хода, на котором кончился archive_001: отрезок архива 3г идёт ещё раз, ничего не пропущено.
    expect(marksOf(value.messages)).toEqual(Array.from({ length: 22 }, (_, k) => mark(38 + k)));
    expect(value.systemPromptAddition).toContain("Session Context Guide");
    expect(asked.filter((p) => p.includes("/archives/")).map((p) => p.split("/").at(-1))).toEqual(probes);
    expect(outcome).toMatchObject({
      recovered: true, reason, summaryFrom: "context", archiveId: "archive_001", boundaryFound: true,
    });
  });

  it("сводка стоит, закрытого архива в досягаемости нет: сводка из ответа и хвост по весу", async () => {
    const live = liveTranscript(60);
    const { client } = server({ context: standingOn3g(1), archives: {} });
    const { value, outcome } = await assemble(live, 12_000, client, {
      holdForSummarySeconds: 0, keepRecentTokens: 12_000, keepRecentFloor: 4,
    });

    expect(JSON.stringify(value.messages[0])).toContain("[Session History Summary]\\nПЕРЕСКАЗ-3Г");
    expect(marksOf(value.messages)).toEqual(Array.from({ length: 12 }, (_, k) => mark(48 + k)));
    expect(value.systemPromptAddition).toContain("Session Context Guide");
    expect(outcome).toMatchObject({
      recovered: true, reason: "no_fresh_summary", summaryFrom: "context", archiveId: null, boundaryFound: false,
    });
  });

  it("архив закрылся уже после ответа и он новее стоящей сводки: его сводка и его граница", async () => {
    const live = liveTranscript(60);
    const { client } = server({
      context: standingOn3g(2),
      // archive_003 и archive_004 ждали сводки, когда сервер отвечал; archive_003 закрылся раньше, чем плагин
      // его спросил, archive_004 ждёт.
      archives: {
        archive_003: { overview: "ПЕРЕСКАЗ-003", lastMessageIndex: 49 },
        archive_001: { overview: "ПЕРЕСКАЗ-СТАРШИЙ", lastMessageIndex: 39 },
      },
    });
    const { value, outcome } = await assemble(live, 12_000, client, { holdForSummarySeconds: 0 });

    expect(JSON.stringify(value.messages[0])).toContain("[Session History Summary]\\nПЕРЕСКАЗ-003");
    expect(JSON.stringify(value.messages)).not.toContain("ПЕРЕСКАЗ-3Г");
    expect(marksOf(value.messages)).toEqual(Array.from({ length: 12 }, (_, k) => mark(48 + k)));
    expect(outcome).toMatchObject({ summaryFrom: "archive", archiveId: "archive_003", boundaryFound: true });
  });
});

describe("сборка, когда свежего пересказа нет", () => {
  it("маленькую переписку отдаёт как есть, тем же массивом", async () => {
    const live = liveTranscript(10);
    const { client, asked } = server({ context: NO_SUMMARY(3, 1, [ovMessage(9)]) });
    const { value, outcome } = await assemble(live, 200_000, client);

    expect(value.messages).toBe(live);
    expect(outcome.passthrough).toBe(true);
    expect(outcome.reason).toBe("no_fresh_summary");
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
      passthrough: false, recovered: true, reason: "no_fresh_summary",
      archiveId: "archive_002", boundaryFound: true, tailMessages: 22, droppedMessages: 0,
    });
    expect(outcome.boundary).toEqual({
      archiveTurns: 3,
      liveMessages: 60,
      liveWithTime: 60,
      timeKinds: { number: 60 },
      matched: new Date(START + 37 * 60_000).toISOString(),
      matchedIndex: 37,
      matchedRole: "assistant",
      // От старого к новому; последний ход архива в поиске не участвует, но виден.
      lastTurns: [
        { at: new Date(START + 35 * 60_000).toISOString(), offMs: 0 },
        { at: new Date(START + 37 * 60_000).toISOString(), offMs: 0 },
        { at: new Date(START + 39 * 60_000).toISOString(), offMs: 0 },
      ],
    });
    expect(warned.join("\n")).toContain("no fresh summary");
  });

  it("у хода перед последним нет пары в переписке: берёт ход ещё раньше, у которого она есть", async () => {
    // Случай 29.09 на сервере: искали 11:26:26.108, ближайшее сообщение стояло в 5838 мс.
    const live = liveTranscript(60);
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59)]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-39", lastMessageIndex: 39, strayTurns: [37] } },
    });
    const { value, outcome, warned } = await assemble(live, 12_000, client);

    // Ход 36–37 без пары, ход 34–35 с парой: хвост с 36-го, без пропуска.
    expect(marksOf(value.messages)).toEqual(Array.from({ length: 24 }, (_, k) => mark(36 + k)));
    expect(outcome).toMatchObject({ recovered: true, boundaryFound: true, tailMessages: 24 });
    expect(outcome.boundary).toMatchObject({
      matched: new Date(START + 35 * 60_000).toISOString(),
      matchedIndex: 35,
      lastTurns: [
        { at: new Date(START + 35 * 60_000).toISOString(), offMs: 0 },
        { at: new Date(START + 37 * 60_000 - 5_838).toISOString(), offMs: 5_838 },
        { at: new Date(START + 39 * 60_000).toISOString(), offMs: 0 },
      ],
    });
    expect(warned.join("\n")).not.toContain("could not be told");
  });

  it("два сообщения с одним временем: режет по первому, следующий ход цел", async () => {
    const live = liveTranscript(60);
    // Сообщение 38 открывает следующий ход и создано в ту же миллисекунду, что ответ 37.
    live[38] = { ...live[38], timestamp: START + 37 * 60_000 };
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59)]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-39", lastMessageIndex: 39 } },
    });
    const { value, outcome } = await assemble(live, 12_000, client);

    expect(marksOf(value.messages)).toEqual(Array.from({ length: 22 }, (_, k) => mark(38 + k)));
    expect(outcome.boundary).toMatchObject({ matchedIndex: 37 });
  });

  it("пара есть только у последнего хода архива: его не берёт, границы нет", async () => {
    const live = liveTranscript(60);
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59)]),
      archives: {
        archive_002: { overview: "ПЕРЕСКАЗ-ДО-39", lastMessageIndex: 39, strayTurns: [35, 37] },
      },
    });
    const { value, outcome } = await assemble(live, 12_000, client);

    // Архив мог кончиться посреди последнего хода, поэтому по нему не режем.
    expect(marksOf(value.messages).at(-1)).toBe(mark(59));
    expect(marksOf(value.messages).length).toBeGreaterThan(22);
    expect(outcome).toMatchObject({ recovered: true, boundaryFound: false, tailMessages: 60 });
    expect(outcome.boundary).toMatchObject({ matched: null, matchedIndex: null });
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

  it("в архиве виден один ход: границу не угадывает, берёт по весу, не меньше планки", async () => {
    const live = liveTranscript(60);
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59)]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ОДИН-ХОД", lastMessageIndex: 1 } },
    });
    // K в 12 000 знаков -- это двенадцать сообщений, планка в двадцать сильнее: остаются двадцать.
    const { value, outcome } = await assemble(live, 12_000, client, { keepRecentTokens: 12_000 });

    expect(JSON.stringify(value.messages[0])).toContain("ПЕРЕСКАЗ-ОДИН-ХОД");
    expect(marksOf(value.messages)).toEqual(Array.from({ length: 20 }, (_, k) => mark(40 + k)));
    expect(outcome).toMatchObject({
      recovered: true, boundaryFound: false, tailMessages: 60, droppedMessages: 40, priced: true,
    });
  });

  it("что тяжелее K, режет со старого конца целыми ходами и говорит, сколько срезал", async () => {
    const live = liveTranscript(60);
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-9", lastMessageIndex: 9 } },
    });
    // Хвост -- 52 сообщения с десятого; под 12 000 знаков -- двенадцать (шесть ходов), не четырнадцать.
    const { value, outcome, warned } = await assemble(live, 12_000, client, {
      keepRecentTokens: 12_000, keepRecentFloor: 4,
    });

    const kept = marksOf(value.messages);
    expect(kept).toEqual(Array.from({ length: 12 }, (_, k) => mark(48 + k)));
    expect(JSON.stringify(value.messages[0])).toContain("ПЕРЕСКАЗ-ДО-9");
    expect(outcome).toMatchObject({ recovered: true, tailMessages: 52, droppedMessages: 40, priced: true });
    expect(Number(outcome.keptWeight)).toBeLessThanOrEqual(12_000);
    expect(Number(outcome.keptWeight)).toBeGreaterThan(10_000);
    expect(warned.join("\n")).toContain("dropped 40 oldest above 12000 by the counter");
  });

  it("без ручки режет одна планка целыми ходами, с предупреждением", async () => {
    const live = liveTranscript(60);
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-9", lastMessageIndex: 9 } },
    });
    const { value, outcome, warned } = await assemble(live, 12_000, client, { handle: false });

    expect(marksOf(value.messages)).toEqual(Array.from({ length: 20 }, (_, k) => mark(40 + k)));
    expect(outcome).toMatchObject({ recovered: true, droppedMessages: 32, priced: false, keptWeight: null });
    expect(warned.join("\n")).toContain("no price handle");
    expect(warned.join("\n")).toContain("dropped 32 oldest beyond the floor, unweighed");
  });

  // PLAN-gorizont 5а (11.10): весы молчат -- веса нет, и хвост без веса не «не влезает»;
  // здесь, в сборке без свежего пересказа, остаётся одна планка, с предупреждением.
  it("весы молчат: режет одна планка целыми ходами, с предупреждением о весе", async () => {
    const live = liveTranscript(60);
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-9", lastMessageIndex: 9 } },
    });
    const { value, outcome, warned } = await assemble(live, 12_000, client, { handle: "silent" });

    expect(marksOf(value.messages)).toEqual(Array.from({ length: 20 }, (_, k) => mark(40 + k)));
    expect(outcome).toMatchObject({ recovered: true, droppedMessages: 32, priced: false, keptWeight: null });
    expect(warned.join("\n")).toContain("gave no weight");
  });

  it("закрытого архива нет: хвост не тяжелее K, начинается с сообщения пользователя", async () => {
    const live = liveTranscript(60);
    const { client, asked } = server({ context: NO_SUMMARY(2, 1, [ovMessage(59, "assistant")]), archives: {} });
    const { value, outcome } = await assemble(live, 12_000, client, { keepRecentTokens: 12_000, keepRecentFloor: 4 });

    expect(JSON.stringify(value.messages)).not.toContain("[Session History Summary]");
    const kept = marksOf(value.messages);
    expect(kept).toEqual(Array.from({ length: 12 }, (_, k) => mark(48 + k)));
    expect(value.messages[0].role).toBe("user");
    expect(Number(outcome.keptWeight)).toBeLessThanOrEqual(12_000);
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

  it("время в живой переписке не читается: хвост по весу, пересказ на месте", async () => {
    const live = liveTranscript(60).map(({ timestamp: _gone, ...rest }) => rest);
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-39", lastMessageIndex: 39 } },
    });
    const { value, outcome } = await assemble(live, 12_000, client);

    expect(JSON.stringify(value.messages[0])).toContain("ПЕРЕСКАЗ-ДО-39");
    const kept = marksOf(value.messages);
    expect(kept.at(-1)).toBe(mark(59));
    // Граница неизвестна -- берём больше, а не меньше: сколько влезает под K, тридцать.
    expect(kept).toEqual(Array.from({ length: 30 }, (_, k) => mark(30 + k)));
    expect(outcome).toMatchObject({ droppedMessages: 30, priced: true });
    expect(outcome).toMatchObject({ recovered: true, archiveId: "archive_002", boundaryFound: false });
    expect(outcome.boundary).toEqual({
      archiveTurns: 3,
      liveMessages: 60,
      liveWithTime: 0,
      timeKinds: { undefined: 60 },
      matched: null,
      matchedIndex: null,
      matchedRole: null,
      lastTurns: [
        { at: new Date(START + 35 * 60_000).toISOString(), offMs: null },
        { at: new Date(START + 37 * 60_000).toISOString(), offMs: null },
        { at: new Date(START + 39 * 60_000).toISOString(), offMs: null },
      ],
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
      liveWithTime: 60, timeKinds: { number: 60 }, matched: null,
      lastTurns: [{ offMs: 7 }, { offMs: 7 }, { offMs: 7 }],
    });
    expect(JSON.stringify(outcome.boundary)).not.toContain("[m");
    expect(warned.join("\n")).toContain("the nearest live messages stand 7, 7, 7 ms off");
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
    const { value, outcome, warned } = await assemble(live, budget, client, { keepRecentTokens: 12_000, keepRecentFloor: 4 });

    expect(marksOf(value.messages)).toEqual(Array.from({ length: 12 }, (_, k) => mark(48 + k)));
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

  it("сервер не отвечает, а переписка целиком не тяжелее K: тем же массивом, по весу", async () => {
    const live = liveTranscript(30);
    const { client } = server({ down: true });
    const { value, outcome } = await assemble(live, 200_000, client, { keepRecentTokens: 150_000 });

    expect(value.messages).toBe(live);
    expect(outcome).toMatchObject({ passthrough: true, keepRecentTokens: 150_000 });
    expect(Number(outcome.liveWeight)).toBeGreaterThan(20_000);
  });

  it("сессии на сервере нет: большая переписка целиком не уходит", async () => {
    const live = liveTranscript(60);
    const { client } = server({
      contextError: { status: 404, code: "NOT_FOUND", message: "Session not found: 9478e347" },
    });
    const { value, outcome } = await assemble(live, budget, client, { keepRecentTokens: 12_000, keepRecentFloor: 4 });

    expect(marksOf(value.messages)).toEqual(Array.from({ length: 12 }, (_, k) => mark(48 + k)));
    expect(outcome).toMatchObject({ recovered: true, reason: "session_not_found", archiveId: null });
  });

  it("на сервере пусто: большая переписка целиком не уходит", async () => {
    const live = liveTranscript(60);
    const { client } = server({ context: NO_SUMMARY(0, 0, []) });
    const { value, outcome } = await assemble(live, budget, client, { keepRecentTokens: 12_000, keepRecentFloor: 4 });

    expect(marksOf(value.messages)).toEqual(Array.from({ length: 12 }, (_, k) => mark(48 + k)));
    expect(outcome).toMatchObject({ recovered: true, reason: "no_ov_data", archiveId: null });
  });
});

describe("запасной путь весит то, что увидит модель (PLAN-krug 7в.5)", () => {
  // Подделка вида шлюза: каждому вопросу штамп в 200 знаков (шлюз ставит штамп времени прошлым вопросам).
  const stamp = "[штамп]".padEnd(200, "ш");
  const historyForModel = async (messages: AgentMessage[]) =>
    messages.map((message) =>
      message.role === "user"
        ? ({
            ...message,
            content: `${stamp}${
              typeof message.content === "string"
                ? message.content
                : (message.content as Array<{ text?: string }>).map((block) => block.text ?? "").join("")
            }`,
          } as AgentMessage)
        : message,
    );

  it("переписка под K, как хранится, но тяжелее K со штампами -- целиком не уходит", async () => {
    // 30 сообщений по 966 знаков -- 28 981 под 30 000; со штампами 31 981. Под K -- 14 ходов (29 849).
    const live = liveTranscript(30);
    const { client } = server({ down: true });
    const { value, outcome } = await assemble(live, 200_000, client, {
      keepRecentTokens: 30_000,
      historyForModel,
    });

    expect(value.messages).not.toBe(live);
    expect(marksOf(value.messages)).toEqual(Array.from({ length: 28 }, (_, k) => mark(2 + k)));
    expect(outcome).toMatchObject({ recovered: true, droppedMessages: 2 });
  });

  it("хвост от границы режет по весу со штампами", async () => {
    // Хвост -- 52 сообщения с десятого; под 12 000 со штампами -- десять (пять ходов, 10 661), не двенадцать.
    const live = liveTranscript(60);
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-9", lastMessageIndex: 9 } },
    });
    const { value } = await assemble(live, 12_000, client, {
      keepRecentTokens: 12_000,
      keepRecentFloor: 4,
      historyForModel,
    });

    expect(marksOf(value.messages)).toEqual(Array.from({ length: 10 }, (_, k) => mark(50 + k)));
  });

  it("хвост весится в форме окна: выдача без вызова, которую окно выбросит, не весится", async () => {
    // Без выдачи под 12 000 -- двенадцать сообщений с 48-го. Выдача без вызова в 3 000 знаков после 53-го в окно
    // не попадёт (починка пар) -- и в весе её нет.
    const live = liveTranscript(60);
    live.splice(54, 0, {
      role: "toolResult",
      toolCallId: "call_orphan",
      toolName: "read",
      content: [{ type: "text", text: "О".repeat(3_000) }],
      isError: false,
      timestamp: START + 53 * 60_000 + 1,
    } as AgentMessage);
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-9", lastMessageIndex: 9 } },
    });
    const { value } = await assemble(live, 12_000, client, { keepRecentTokens: 12_000, keepRecentFloor: 4 });

    expect(marksOf(value.messages)).toEqual(Array.from({ length: 12 }, (_, k) => mark(48 + k)));
    expect(JSON.stringify(value.messages)).not.toContain("call_orphan");
  });
});

describe("окно не теряет выдачу повторного номера вызова (PLAN-krug 7в.5-3, НВ5-1)", () => {
  // Сервер хранит вызовы разных ходов под одним номером; починка пар окна выбрасывала выдачу второго как дубль.
  const toolsOf = (messages: AgentMessage[]) => ({
    calls: messages.flatMap((m) =>
      m.role === "assistant" && Array.isArray(m.content)
        ? (m.content as Array<{ type?: string; id?: string }>).filter((b) => b.type === "toolCall").map((b) => b.id)
        : [],
    ),
    results: messages.flatMap((m) => (m.role === "toolResult" ? [(m as { toolCallId?: string }).toolCallId] : [])),
  });

  it("главный путь: обе выдачи в окне, у каждого вызова своя", async () => {
    const at = (i: number) => new Date(START + i * 60_000).toISOString();
    const call = (id: string, text: string, i: number): OVMessage => ({
      id,
      role: "assistant",
      parts: [
        { type: "tool", tool_id: "call_115472", tool_name: "read", tool_input: { path: text }, tool_output: `ВЫДАЧА-${text}`, tool_status: "completed" },
      ] as OVMessage["parts"],
      created_at: at(i),
    });
    const { client } = server({
      context: {
        latest_archive_overview: "ПЕРЕСКАЗ-СВЕЖИЙ",
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "раз" }], created_at: at(0) },
          call("a1", "первый", 1),
          { id: "u2", role: "user", parts: [{ type: "text", text: "два" }], created_at: at(2) },
          call("a2", "второй", 3),
        ] as OVMessage[],
        stats: {
          totalArchives: 3, includedArchives: 0, droppedArchives: 3,
          failedArchives: 0, activeTokens: 10, archiveTokens: 5,
        },
      },
    });
    const { value, outcome } = await assemble(liveTranscript(60), 12_000, client);

    expect(outcome).toMatchObject({ passthrough: false });
    expect(JSON.stringify(value.messages)).toContain("ВЫДАЧА-первый");
    expect(JSON.stringify(value.messages)).toContain("ВЫДАЧА-второй");
    const { calls, results } = toolsOf(value.messages);
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(2);
    expect(results).toEqual(calls);
  });

  it("запасной путь: урезанное окно тоже держит обе выдачи", async () => {
    const live = liveTranscript(54);
    const turn = (n: number, text: string): AgentMessage[] => [
      { role: "user", content: `вопрос ${text}`, timestamp: START + n * 60_000 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_115472", name: "read", arguments: { path: text } }],
        timestamp: START + (n + 1) * 60_000,
      },
      {
        role: "toolResult",
        toolCallId: "call_115472",
        toolName: "read",
        content: [{ type: "text", text: `ВЫДАЧА-${text}` }],
        isError: false,
        timestamp: START + (n + 1) * 60_000 + 1,
      },
      { role: "assistant", content: [{ type: "text", text: `прочла ${text}` }], timestamp: START + (n + 2) * 60_000 },
    ] as AgentMessage[];
    live.push(...turn(54, "первый"), ...turn(57, "второй"));
    const { client } = server({ down: true });
    const { value, outcome } = await assemble(live, 12_000, client, { keepRecentTokens: 12_000, keepRecentFloor: 4 });

    expect(outcome).toMatchObject({ recovered: true });
    expect(JSON.stringify(value.messages)).toContain("ВЫДАЧА-первый");
    expect(JSON.stringify(value.messages)).toContain("ВЫДАЧА-второй");
    const { calls, results } = toolsOf(value.messages);
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(2);
    expect(results).toEqual(calls);
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
      cfg: memoryOpenVikingConfigSchema.parse({
        baseUrl: "http://127.0.0.1:1933", autoRecall: false, keepRecentTokens: 30_000,
      }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      getClient: async () => client,
      resolveAgentId: () => "main",
      priceHandle: charsHandle(),
    });
    const value = await engine.assemble({
      sessionId: "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3",
      messages: live,
      tokenBudget: 12_000,
      availableTools: new Set<string>(),
      runtimeSettings: { model: { resolved: "gemini-3.5-flash-lite", requested: null } },
    } as never);

    expect(JSON.stringify(value.messages[0])).toContain("ПЕРЕСКАЗ-ДО-39");
    expect(marksOf(value.messages as AgentMessage[])).toEqual(Array.from({ length: 22 }, (_, k) => mark(38 + k)));
  });
});

// PLAN-krug 7в.3в: every main assembly tells the host the window's state -- "partial" while the window goes by the
// fallback path not whole (summary and a cut tail), "whole" otherwise -- so the web and the channel show a line while
// part of the conversation is out of the model's sight and take it down once a later assembly is whole again.
describe("состояние окна для хоста (PLAN-krug 7в.3в)", () => {
  const engineOver = (client: OpenVikingClient, keepRecentTokens = 30_000) =>
    createMemoryOpenVikingContextEngine({
      id: "openviking",
      name: "OpenViking",
      cfg: memoryOpenVikingConfigSchema.parse({
        baseUrl: "http://127.0.0.1:1933", autoRecall: false, keepRecentTokens,
      }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      getClient: async () => client,
      resolveAgentId: () => "main",
      priceHandle: charsHandle(),
    });
  const mainAssemble = (client: OpenVikingClient, live: AgentMessage[], keepRecentTokens?: number) =>
    engineOver(client, keepRecentTokens).assemble({
      sessionId: "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3",
      messages: live,
      tokenBudget: 12_000,
      availableTools: new Set<string>(),
      runtimeSettings: { model: { resolved: "gemini-3.5-flash-lite", requested: null } },
    } as never) as Promise<{ messages: AgentMessage[]; contextWindow?: string }>;

  // 22 сообщения от границы архива весят около 21 250 -- под K 12 000 не влезают, старые срезаны.
  it("запасной путь срезал старое -- partial", async () => {
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-39", lastMessageIndex: 39 } },
    });
    const value = await mainAssemble(client, liveTranscript(60), 12_000);
    expect(value.contextWindow).toBe("partial");
  });

  // Проверяющий кода 7в.3в, Н4: сводка и весь хвост от границы влезли под K -- из окна ничего не выпало.
  it("запасной путь вместил всё от границы архива -- whole", async () => {
    const { client } = server({
      context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]),
      archives: { archive_002: { overview: "ПЕРЕСКАЗ-ДО-39", lastMessageIndex: 39 } },
    });
    const value = await mainAssemble(client, liveTranscript(60));
    expect(JSON.stringify(value.messages[0])).toContain("ПЕРЕСКАЗ-ДО-39");
    expect(value.contextWindow).toBe("whole");
  });

  it("главный путь -- whole", async () => {
    const { client } = server({
      context: {
        latest_archive_overview: "ПЕРЕСКАЗ-СВЕЖИЙ",
        messages: [ovMessage(58, "user"), ovMessage(59, "assistant")],
        stats: {
          totalArchives: 3, includedArchives: 0, droppedArchives: 3,
          failedArchives: 0, activeTokens: 10, archiveTokens: 5, unsummarizedArchives: 0,
        },
      },
    });
    const value = await mainAssemble(client, liveTranscript(60));
    expect(value.contextWindow).toBe("whole");
  });

  it("запасной путь отдал переписку целиком -- whole", async () => {
    const { client } = server({ context: NO_SUMMARY(3, 1, [ovMessage(9)]) });
    const live = liveTranscript(10);
    const value = await mainAssemble(client, live);
    expect(value.messages).toBe(live);
    expect(value.contextWindow).toBe("whole");
  });

  it("сборка не главная (память к запросу) -- без состояния", async () => {
    const { client } = server({ context: NO_SUMMARY(3, 1, [ovMessage(59, "assistant")]) });
    const value = (await engineOver(client).assemble({
      sessionId: "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3",
      messages: liveTranscript(60),
      tokenBudget: 12_000,
    } as never)) as { contextWindow?: string };
    expect(value).not.toHaveProperty("contextWindow");
  });
});
