import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, type OVMessage } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";
import type { PriceVerdict } from "../price-handle.js";

/*
 * Разлив, когда весы молчат (PLAN-gorizont 5а, решение Вита 11.10).
 *
 * Весы -- ручка цены прокси: «сколько весит этот набор сообщений». В шторм прокси не
 * может спросить Гугл и отвечает ошибкой. Раньше плагин принимал молчание за «хвост не
 * влезает» и оставлял в окне пол -- двадцать сообщений. Числа не от счётчика нет и быть
 * не может, поэтому теперь: весы молчат в конце хода -- разлива нет, плагин помечает
 * сессию «разлив должен»; следующий ход держится в начале (хосту объявлено сжатие, как
 * при ожидании сводки), весы спрашиваются раз в паузу до предела; ответили -- разлив,
 * потом ожидание сводки, и ход идёт на сжатом окне; молчат весь срок -- ход идёт как
 * есть, метка остаётся, следующий ход ждёт снова.
 */

const SESSION = "6b5c1b0a-2a9f-4d2e-9c0b-000000000000";
const X = 245_000;
const K = 150_000;

type State = {
  unsummarized: number;
  sessionPolls: number;
  standsAfterPolls: number;
  messages: OVMessage[];
};

type Stand = { client: OpenVikingClient; commits: Array<Record<string, unknown>>; state: State; asked: string[] };

function ovMessage(i: number, chars: number): OVMessage {
  return {
    id: `ov-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `[m${String(i).padStart(3, "0")}]`.padEnd(chars, "а") }],
    created_at: new Date(Date.UTC(2026, 9, 11, 0, i)).toISOString(),
  };
}

/** Сервер: 20 ходов по два сообщения в 5 000 знаков; коммит ставит сводку в очередь, она
 * встаёт после двух опросов сессии и укорачивает живые сообщения. */
function server(given: Partial<State> = {}): Stand {
  const state: State = {
    unsummarized: 0,
    sessionPolls: 0,
    standsAfterPolls: 2,
    messages: Array.from({ length: 40 }, (_, i) => ovMessage(i, 5_000)),
    ...given,
  };
  const commits: Array<Record<string, unknown>> = [];
  const asked: string[] = [];
  const transport: HttpTransport = vi.fn(async (url, init) => {
    const parsed = new URL(url);
    asked.push(`${init?.method ?? "GET"} ${parsed.pathname}`);
    const answer = (body: unknown) =>
      new Response(JSON.stringify({ status: "ok", result: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (parsed.pathname.endsWith("/messages")) {
      return answer({ session_id: SESSION });
    }
    if (parsed.pathname.endsWith("/commit")) {
      commits.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      state.unsummarized += 1;
      state.sessionPolls = 0;
      return answer({ status: "accepted", archived: true, task_id: "task-1" });
    }
    if (parsed.pathname.endsWith("/context")) {
      return answer({
        latest_archive_overview: state.unsummarized > 0 ? "" : "СВОДКА",
        pre_archive_abstracts: [],
        messages: state.messages,
        estimatedTokens: 4_000,
        stats: {
          totalArchives: 1, includedArchives: state.unsummarized > 0 ? 0 : 1, droppedArchives: 0,
          failedArchives: 0, activeTokens: 1, archiveTokens: 1, unsummarizedArchives: state.unsummarized,
        },
      });
    }
    if (/\/api\/v1\/tasks\/[^/]+$/.test(parsed.pathname)) {
      return answer({ task_id: "task-1", task_type: "session_commit", created_at: 0, updated_at: 0, status: "running" });
    }
    if (/\/api\/v1\/sessions\/[^/]+$/.test(parsed.pathname)) {
      state.sessionPolls += 1;
      if (state.unsummarized > 0 && state.sessionPolls >= state.standsAfterPolls) {
        state.unsummarized = 0;
        state.messages = state.messages.slice(-4);
      }
      return answer({ pending_tokens: 0, unsummarized_archives: state.unsummarized });
    }
    return new Response(JSON.stringify({ status: "error", error: { code: "NOT_FOUND", message: parsed.pathname } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  });
  const client = new OpenVikingClient("http://127.0.0.1:1933", "ov-key", "main", 5_000, "", "", undefined, {
    transport,
  });
  return { client, commits, state, asked };
}

/** Весы: вес тела -- сумма знаков содержимого; пока `silent()` истинно, молчат (нет вердикта). */
function scales(silent: () => boolean) {
  let asked = 0;
  const price = {
    url: "http://127.0.0.1:8787/price",
    price: async (body: Record<string, unknown>): Promise<PriceVerdict | null> => {
      asked += 1;
      if (silent()) {
        return null;
      }
      const typed = body as { model: string; messages: Array<{ content: unknown }> };
      const charge = typed.messages.reduce(
        (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
        0,
      );
      return { model: typed.model, charge, ours: charge, google: null, surcharge: 0, ceiling: 249_000, fits: charge <= 249_000 };
    },
  };
  return { price, asked: () => asked };
}

function engineOver(stand: Stand, price: ReturnType<typeof scales>["price"], holdForSummarySeconds = 5) {
  const diags: Array<{ stage: string; data: Record<string, unknown> }> = [];
  const warned: string[] = [];
  const engine = createMemoryOpenVikingContextEngine({
    id: "openviking",
    name: "OpenViking",
    cfg: memoryOpenVikingConfigSchema.parse({
      baseUrl: "http://127.0.0.1:1933",
      autoRecall: false,
      emitStandardDiagnostics: true,
      pourOffAtTokens: X,
      keepRecentTokens: K,
      keepRecentFloor: 20,
      holdForSummarySeconds,
    }),
    logger: {
      info: (line) => {
        const found = /^openviking: diag (.*)$/.exec(line);
        if (found) {
          const parsed = JSON.parse(found[1]) as { stage: string; data: Record<string, unknown> };
          diags.push({ stage: parsed.stage, data: parsed.data });
        }
      },
      warn: (line) => warned.push(line),
      error: () => {},
    },
    getClient: async () => stand.client,
    resolveAgentId: () => "main",
    priceHandle: price,
    pollIntervalMs: 1,
    pourRetryPauseMs: 1,
  });
  return { engine, diags, warned, lastDiag: (stage: string) => diags.filter((d) => d.stage === stage).at(-1)?.data };
}

const MODEL = { model: { resolved: "gemini-3.5-flash-lite", requested: "gemini-3.5-flash-lite" } };

function turn(tag: string) {
  return [
    { role: "user", content: `вопрос ${tag}`, timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: `ответ ${tag}` }], timestamp: 2 },
  ];
}

/** Конец хода: запись хода `tag` с весом окна `window` (разлив, если не ниже X). */
async function endOfTurn(
  engine: ReturnType<typeof engineOver>["engine"],
  sessionId: string,
  window: number,
  tag = "прошлый",
) {
  await engine.afterTurn?.({
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    messages: turn(tag) as never,
    prePromptMessageCount: 0,
    runtimeContext: { currentTokenCount: window },
    runtimeSettings: MODEL,
  } as never);
}

/** Начало следующего хода: главная сборка (с вопросом). */
async function startOfTurn(engine: ReturnType<typeof engineOver>["engine"], sessionId: string, announce: ReturnType<typeof vi.fn>) {
  return await engine.assemble({
    sessionId,
    messages: [{ role: "user", content: "вопрос следующий", timestamp: 3 }] as never,
    tokenBudget: 249_000,
    prompt: "вопрос следующий",
    runtimeSettings: MODEL,
    announceCompaction: announce,
  } as never);
}

describe("весы молчат в конце хода", () => {
  it("разлива нет, причина no_weight, хосту ничего не объявляется", async () => {
    const stand = server();
    const { price, asked } = scales(() => true);
    const { engine, lastDiag, warned } = engineOver(stand, price);
    const sessionId = `${SESSION}-end`;

    await endOfTurn(engine, sessionId, X);

    expect(stand.commits).toEqual([]);
    expect(lastDiag("pour_skip")).toMatchObject({ reason: "no_weight", window: X });
    expect(asked()).toBeGreaterThanOrEqual(1);
    expect(warned.join("\n")).toMatch(/no weight/);
  });

  it("следующий ход держится и разливает, когда весы ответили; потом ждёт сводку", async () => {
    const stand = server();
    let silent = true;
    const { price } = scales(() => silent);
    const { engine, lastDiag, diags } = engineOver(stand, price);
    const sessionId = `${SESSION}-hold`;
    await endOfTurn(engine, sessionId, X);
    expect(stand.commits).toEqual([]);

    const announce = vi.fn();
    // К началу следующего хода весы снова отвечают.
    silent = false;
    const result = await startOfTurn(engine, sessionId, announce);

    // Разлив случился в начале хода: оставлены 14 ходов (28 сообщений) весом 140 001 под K.
    expect(stand.commits).toEqual([{ keep_recent_count: 28 }]);
    expect(lastDiag("pour_hold")).toMatchObject({ outcome: "poured" });
    expect(lastDiag("pour_off")).toMatchObject({ path: "assemble", keptMessages: 28, windowAfter: 185_000 });
    // Одно объявление на всё: от начала ожидания весов до вставшей сводки; конец несёт разлив.
    expect(announce.mock.calls).toEqual([
      ["start"],
      ["end", { completed: true, compacted: true, tokensAfter: 185_000 }],
    ]);
    expect(diags.filter((d) => d.stage === "hold_for_summary")).toHaveLength(1);
    expect(stand.state.unsummarized).toBe(0);
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("весы ответили не сразу: ожидание переспрашивает их с паузой", async () => {
    const stand = server();
    let asks = 0;
    const { price } = scales(() => {
      asks += 1;
      // Конец хода: молчат (один вопрос). Начало следующего: молчат ещё дважды, потом отвечают.
      return asks <= 3;
    });
    const { engine, lastDiag } = engineOver(stand, price);
    const sessionId = `${SESSION}-retry`;
    await endOfTurn(engine, sessionId, X);
    const announce = vi.fn();

    await startOfTurn(engine, sessionId, announce);

    expect(stand.commits).toEqual([{ keep_recent_count: 28 }]);
    expect(lastDiag("pour_hold")).toMatchObject({ outcome: "poured", attempts: 3 });
    expect(announce.mock.calls.at(-1)).toEqual(["end", { completed: true, compacted: true, tokensAfter: 185_000 }]);
  });

  it("весы молчат весь срок: ход идёт как есть, конец без успеха, метка остаётся, следующий ход ждёт снова", async () => {
    const stand = server();
    const { price } = scales(() => true);
    const { engine, lastDiag, warned } = engineOver(stand, price, 0.02);
    const sessionId = `${SESSION}-gave-up`;
    await endOfTurn(engine, sessionId, X);
    const announce = vi.fn();

    await startOfTurn(engine, sessionId, announce);

    expect(stand.commits).toEqual([]);
    expect(lastDiag("pour_hold")).toMatchObject({ outcome: "gave_up" });
    expect(announce.mock.calls).toEqual([["start"], ["end", { completed: false }]]);
    expect(warned.join("\n")).toMatch(/gate/);

    announce.mockClear();
    await startOfTurn(engine, sessionId, announce);
    expect(announce.mock.calls).toEqual([["start"], ["end", { completed: false }]]);
  });

  it("пока ждали, разлив уже случился иначе: метка снимается, дальше ожидание сводки как обычно", async () => {
    const stand = server();
    const { price } = scales(() => true);
    const { engine, lastDiag } = engineOver(stand, price);
    const sessionId = `${SESSION}-elsewhere`;
    await endOfTurn(engine, sessionId, X);
    stand.state.unsummarized = 1;
    const announce = vi.fn();

    await startOfTurn(engine, sessionId, announce);

    expect(stand.commits).toEqual([]);
    expect(lastDiag("pour_hold")).toMatchObject({ outcome: "pending_elsewhere" });
    expect(announce.mock.calls).toEqual([["start"], ["end", { completed: true }]]);
    expect(stand.state.unsummarized).toBe(0);
  });

  it("окно опустилось ниже X к концу следующего хода: метка снимается, ожидания нет", async () => {
    const stand = server();
    const { price } = scales(() => true);
    const { engine, lastDiag } = engineOver(stand, price);
    const sessionId = `${SESSION}-below`;
    await endOfTurn(engine, sessionId, X, "тяжёлый");
    await endOfTurn(engine, sessionId, X - 1, "лёгкий");
    expect(lastDiag("pour_skip")).toMatchObject({ reason: "below_x" });
    const announce = vi.fn();

    await startOfTurn(engine, sessionId, announce);

    expect(announce).not.toHaveBeenCalled();
    expect(lastDiag("pour_hold")).toBeUndefined();
  });

  it("без метки главная сборка весов не ждёт", async () => {
    const stand = server();
    const { price, asked } = scales(() => true);
    const { engine, lastDiag } = engineOver(stand, price);
    const announce = vi.fn();

    await startOfTurn(engine, `${SESSION}-no-mark`, announce);

    expect(announce).not.toHaveBeenCalled();
    expect(lastDiag("pour_hold")).toBeUndefined();
    expect(asked()).toBe(0);
  });
});
