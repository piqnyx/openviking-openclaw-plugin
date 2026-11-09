import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, type OVMessage } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";
import type { PriceVerdict } from "../price-handle.js";

/*
 * Отливание по X (PLAN-gorizont, 4б).
 *
 * После хода плагин знает точный вес окна: шлюз передаёт списание последнего запроса, как его
 * посчитал прокси. Окно весит X или больше -- плагин отливает: оставляет модели самые новые
 * сообщения весом не больше K (по ручке, целыми ходами, не меньше планки) и просит сервер
 * убрать остальное в архив; сводку сервер пишет в фоне. Пока сводка прошлого отливания не
 * записана, сервер отдаёт его сырьё и говорит об этом счётчиком -- плагин не отливает снова.
 * K -- верхняя планка: оставляется не больше, чем влезает под X вместе с постоянной частью
 * окна (окно минус вес всех сообщений).
 */

const SESSION = "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3";
const X = 245_000;
const K = 150_000;

type Stand = {
  client: OpenVikingClient;
  commits: Array<Record<string, unknown>>;
  asked: string[];
};

function ovMessage(i: number, chars: number): OVMessage {
  return {
    id: `ov-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `[m${String(i).padStart(3, "0")}]`.padEnd(chars, "а") }],
    created_at: new Date(Date.UTC(2026, 9, 7, 0, i)).toISOString(),
  };
}

/** Сервер: столько ходов по два сообщения, каждое из `chars` знаков; счётчик висящих без сводки (null -- сервер его не знает). */
function server(turns: number, chars: number, unsummarized: number | null = 0, archived = true): Stand {
  const commits: Array<Record<string, unknown>> = [];
  const asked: string[] = [];
  const messages = Array.from({ length: turns * 2 }, (_, i) => ovMessage(i, chars));
  const transport: HttpTransport = vi.fn(async (url, init) => {
    const parsed = new URL(url);
    asked.push(`${init?.method ?? "GET"} ${parsed.pathname}${parsed.search}`);
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
      return answer({ status: "accepted", archived, task_id: "task-1" });
    }
    if (parsed.pathname.endsWith("/context")) {
      return answer({
        latest_archive_overview: "СВОДКА",
        pre_archive_abstracts: [],
        messages,
        estimatedTokens: 1,
        stats: {
          totalArchives: 1, includedArchives: 1, droppedArchives: 0, failedArchives: 0,
          activeTokens: 1, archiveTokens: 1,
          ...(unsummarized === null ? {} : { unsummarizedArchives: unsummarized }),
        },
      });
    }
    if (/\/api\/v1\/sessions\/[^/]+$/.test(parsed.pathname)) {
      return answer({ pending_tokens: 0, unsummarized_archives: unsummarized ?? 0 });
    }
    return new Response(JSON.stringify({ status: "error", error: { code: "NOT_FOUND", message: parsed.pathname } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  });
  const client = new OpenVikingClient("http://127.0.0.1:1933", "ov-key", "main", 5_000, "", "", undefined, {
    transport,
  });
  return { client, commits, asked };
}

/** Ручка: вес тела -- сумма знаков содержимого; так хвост из n сообщений по c знаков весит n·c + 1 за «x». */
function handle() {
  const bodies: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }> = [];
  const price = {
    url: "http://127.0.0.1:8787/price",
    price: async (body: Record<string, unknown>): Promise<PriceVerdict | null> => {
      const typed = body as { model: string; messages: Array<{ role: string; content: unknown }> };
      bodies.push(typed);
      const charge = typed.messages.reduce(
        (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
        0,
      );
      return { model: typed.model, charge, ours: charge, google: null, surcharge: 0, ceiling: 249_000, fits: charge <= 249_000 };
    },
  };
  return { price, bodies };
}

function engineOver(
  stand: Stand,
  priceHandle: ReturnType<typeof handle>["price"] | undefined,
  keepRecentFloor = 20,
  extraCfg: Record<string, unknown> = {},
) {
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
      keepRecentFloor,
      ...extraCfg,
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
    ...(priceHandle ? { priceHandle } : {}),
  });
  return { engine, diags, warned };
}

function turn(tag: string) {
  return [
    { role: "user", content: `вопрос ${tag}`, timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: `ответ ${tag}` }], timestamp: 2 },
  ];
}

/** `model` null -- шлюз модель не назвал (настройки без неё). */
async function afterTurn(
  engine: ReturnType<typeof engineOver>["engine"],
  tag: string,
  window: number | undefined,
  model: string | null = "gemini-3.5-flash-lite",
  announceCompaction?: (phase: "start" | "end", info?: Record<string, unknown>) => void,
) {
  await engine.afterTurn?.({
    sessionId: `${SESSION}-${tag}`,
    sessionFile: `/tmp/${tag}.jsonl`,
    messages: turn(tag) as never,
    prePromptMessageCount: 0,
    runtimeContext: window === undefined ? {} : { currentTokenCount: window },
    ...(model === null ? {} : { runtimeSettings: { model: { resolved: model, requested: model } } }),
    ...(announceCompaction ? { announceCompaction } : {}),
  } as never);
}

function lastDiag(diags: Array<{ stage: string; data: Record<string, unknown> }>, stage: string) {
  return diags.filter((d) => d.stage === stage).at(-1)?.data;
}

describe("отливание по X", () => {
  it("окно легче X -- ничего не отливается, ручка не спрашивается", async () => {
    const stand = server(20, 10_000);
    const { price, bodies } = handle();
    const { engine, diags } = engineOver(stand, price);
    await afterTurn(engine, "below", X - 1);
    expect(stand.commits).toEqual([]);
    expect(bodies).toEqual([]);
    expect(lastDiag(diags, "pour_skip")).toMatchObject({ reason: "below_x", window: X - 1 });
  });

  it("окно весит X -- остаётся самый длинный хвост целых ходов не тяжелее K, остальное в архив", async () => {
    // 20 ходов по два сообщения в 5 000 знаков: ход весит 10 000; не тяжелее 150 000 -- 14 ходов
    // (140 001 с «x»), пятнадцать весили бы 150 001.
    const stand = server(20, 5_000);
    const { price, bodies } = handle();
    const { engine, diags, warned } = engineOver(stand, price);
    await afterTurn(engine, "at-x", X);
    expect(stand.commits).toEqual([{ keep_recent_count: 28 }]);
    expect(warned).toEqual([]);
    // Вес всех плюс двоичный поиск по границам: не больше шести обращений.
    expect(bodies.length).toBeLessThanOrEqual(6);
    for (const body of bodies) {
      expect(body.model).toBe("gemini-3.5-flash-lite");
      expect(body.messages.at(-1)).toEqual({ role: "user", content: "x" });
    }
    expect(lastDiag(diags, "pour_off")).toMatchObject({
      window: X,
      rest: 44_999,
      cap: K,
      keptMessages: 28,
      keptWeight: 140_001,
      archivedMessages: 12,
      priced: true,
      taskId: "task-1",
    });
    expect(stand.asked.filter((line) => line.includes("/context"))).toEqual([
      `GET /api/v1/sessions/${SESSION}-at-x/context?token_budget=1000000000`,
    ]);
  });

  it("K -- верхняя планка: остаётся не больше, чем влезает под X с постоянной частью окна", async () => {
    // Десять ходов по два сообщения в 1 000 знаков: все вместе 20 001; окно 250 000, значит
    // постоянная часть 229 999 и под X влезает 15 001 -- семь ходов (14 001), не восемь (16 001).
    // Планка 4, чтобы решал вес.
    const stand = server(10, 1_000);
    const { price } = handle();
    const { engine, diags } = engineOver(stand, price, 4);
    await afterTurn(engine, "cap", 250_000);
    expect(stand.commits).toEqual([{ keep_recent_count: 14 }]);
    expect(lastDiag(diags, "pour_off")).toMatchObject({
      window: 250_000, rest: 229_999, cap: 15_001, keptMessages: 14, keptWeight: 14_001, archivedMessages: 6,
    });
  });

  it("окно на X из-за постоянной части, а сообщения лёгкие: все остаются, сервер не трогается", async () => {
    // Все сообщения весят 20 001 и влезают под X целиком: cap равен им, отливать нечего.
    const stand = server(10, 1_000);
    const { price } = handle();
    const { engine, diags, warned } = engineOver(stand, price, 4);
    await afterTurn(engine, "light", X);
    expect(stand.commits).toEqual([]);
    expect(lastDiag(diags, "pour_skip")).toMatchObject({
      reason: "nothing_to_pour", rest: 224_999, cap: 20_001, allWeight: 20_001, pendingMessages: 20,
    });
    expect(warned.join("\n")).toMatch(/nothing to pour/);
  });

  it("сводка прошлого отливания ещё не записана -- не отливать снова", async () => {
    const stand = server(20, 10_000, 1);
    const { price, bodies } = handle();
    const { engine, diags } = engineOver(stand, price);
    await afterTurn(engine, "pending", X);
    expect(stand.commits).toEqual([]);
    expect(bodies).toEqual([]);
    expect(lastDiag(diags, "pour_skip")).toMatchObject({ reason: "summary_pending", unsummarizedArchives: 1 });
  });

  it("сервер без счётчика висящих -- предупреждение, отливание идёт", async () => {
    const stand = server(20, 5_000, null);
    const { price } = handle();
    const { engine, warned } = engineOver(stand, price);
    await afterTurn(engine, "old-server", X);
    expect(stand.commits).toEqual([{ keep_recent_count: 28 }]);
    expect(warned.join("\n")).toMatch(/unsummarizedArchives/);
  });

  it("ручки нет -- хвост по планке целыми ходами, предупреждение", async () => {
    const stand = server(20, 10_000);
    const { engine, warned, diags } = engineOver(stand, undefined);
    await afterTurn(engine, "no-handle", X);
    expect(stand.commits).toEqual([{ keep_recent_count: 20 }]);
    expect(warned.join("\n")).toMatch(/without a price/);
    expect(lastDiag(diags, "pour_off")).toMatchObject({ keptMessages: 20, keptWeight: null, priced: false });
  });

  it("модель не названа -- как без ручки", async () => {
    const stand = server(20, 10_000);
    const { price, bodies } = handle();
    const { engine, warned } = engineOver(stand, price);
    await afterTurn(engine, "no-model", X, null);
    expect(stand.commits).toEqual([{ keep_recent_count: 20 }]);
    expect(bodies).toEqual([]);
    expect(warned.join("\n")).toMatch(/model/);
  });

  it("планка целыми ходами: двадцать сообщений начинаются с вопроса, а не посреди хода", async () => {
    // Ходы из трёх сообщений (вопрос, ответ инструмента, ответ): двадцать с границы -- это 21.
    const threes = Array.from({ length: 30 }, (_, i) => ({
      id: `ov-${i}`,
      role: i % 3 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `[m${String(i).padStart(3, "0")}]` }],
      created_at: new Date(Date.UTC(2026, 9, 7, 0, i)).toISOString(),
    }));
    const withThrees = serverOf(threes);
    const { engine } = engineOver(withThrees, undefined);
    await afterTurn(engine, "threes", X);
    expect(withThrees.commits).toEqual([{ keep_recent_count: 21 }]);
  });

  it("веса окна нет -- отливать не по чему", async () => {
    const stand = server(20, 10_000);
    const { price } = handle();
    const { engine, diags } = engineOver(stand, price);
    await afterTurn(engine, "no-weight", undefined);
    expect(stand.commits).toEqual([]);
    expect(lastDiag(diags, "pour_skip")).toMatchObject({ reason: "no_window_weight" });
  });

  it("сообщений меньше планки -- отливать нечего, предупреждение", async () => {
    const stand = server(3, 10_000);
    const { price } = handle();
    const { engine, diags, warned } = engineOver(stand, price);
    await afterTurn(engine, "few", X);
    expect(stand.commits).toEqual([]);
    expect(lastDiag(diags, "pour_skip")).toMatchObject({ reason: "nothing_to_pour", window: X });
    expect(warned.join("\n")).toMatch(/nothing to pour/);
  });

  // Файл 37 шлюза (PLAN-gorizont 2б): разлив -- сжатие сессии для хоста. Плагин говорит об
  // этом ручкой хоста законченным «end» с оценкой веса окна после: постоянная часть плюс
  // вес оставленного хвоста; хост считает цикл сжатия и берёт оценку за свежий вес окна,
  // чтобы сброс памяти не сработал на старом весе сразу после разлива.
  it("разлив объявляется хосту законченным сжатием с оценкой веса окна после", async () => {
    const stand = server(20, 5_000);
    const { price } = handle();
    const { engine, diags } = engineOver(stand, price);
    const announce = vi.fn();
    await afterTurn(engine, "announce", X, "gemini-3.5-flash-lite", announce);
    expect(stand.commits).toEqual([{ keep_recent_count: 28 }]);
    // Постоянная часть 44 999 плюс хвост 140 001. PLAN-krug 7в.3а-2: «начало» -- на время взвешивания и записи.
    expect(announce.mock.calls).toEqual([["start"], ["end", { completed: true, tokensAfter: 185_000 }]]);
    expect(lastDiag(diags, "pour_off")).toMatchObject({ rest: 44_999, keptWeight: 140_001, windowAfter: 185_000 });
  });

  // PLAN-krug 7в.3а-2: ниже X ручка хоста молчит; от X хост видит работу -- «начало» и «конец», но без записанного
  // архива «конец» всегда несёт completed: false, иначе хост посчитает лишнее сжатие и взведёт тихий ход не по делу.
  it("без разлива: ниже X ручка хоста молчит, от X -- начало и незаконченный конец", async () => {
    const { price } = handle();
    const quiet = vi.fn();
    const below = engineOver(server(20, 10_000), price);
    await afterTurn(below.engine, "quiet-below", X - 1, "gemini-3.5-flash-lite", quiet);
    expect(quiet).not.toHaveBeenCalled();

    const pendingAnnounce = vi.fn();
    const pending = engineOver(server(20, 10_000, 1), price);
    await afterTurn(pending.engine, "quiet-pending", X, "gemini-3.5-flash-lite", pendingAnnounce);
    expect(pendingAnnounce.mock.calls).toEqual([["start"], ["end", { completed: false }]]);

    const lightAnnounce = vi.fn();
    const light = engineOver(server(10, 1_000), price, 4);
    await afterTurn(light.engine, "quiet-light", X, "gemini-3.5-flash-lite", lightAnnounce);
    expect(lightAnnounce.mock.calls).toEqual([["start"], ["end", { completed: false }]]);
  });

  it("сервер ничего не заархивировал -- сжатием не считается", async () => {
    const stand = server(20, 5_000, 0, false);
    const { price } = handle();
    const { engine, diags } = engineOver(stand, price);
    const announce = vi.fn();
    await afterTurn(engine, "not-archived", X, "gemini-3.5-flash-lite", announce);
    expect(stand.commits).toEqual([{ keep_recent_count: 28 }]);
    expect(announce.mock.calls).toEqual([["start"], ["end", { completed: false }]]);
    expect(lastDiag(diags, "pour_off")).toMatchObject({ archived: false });
  });

  it("без ручки цены разлив объявляется без веса, с предупреждением", async () => {
    const stand = server(20, 10_000);
    const { engine, warned } = engineOver(stand, undefined);
    const announce = vi.fn();
    await afterTurn(engine, "no-handle-announce", X, "gemini-3.5-flash-lite", announce);
    expect(announce.mock.calls).toEqual([["start"], ["end", { completed: true }]]);
    expect(warned.join("\n")).toMatch(/weight of the window after/);
  });

  // PLAN-krug 7в.3а-2 (НЗ2-7): the host's ear failing on the start costs the picture, not the pour-off.
  it("ручка хоста бросила на начале -- слив всё равно идёт", async () => {
    const stand = server(20, 5_000);
    const { price } = handle();
    const { engine, warned } = engineOver(stand, price);
    const announce = vi.fn((phase: string) => {
      if (phase === "start") {
        throw new Error("host gone");
      }
    });
    await afterTurn(engine, "throwing-ear", X, "gemini-3.5-flash-lite", announce);
    expect(stand.commits).toEqual([{ keep_recent_count: 28 }]);
    expect(announce.mock.calls.at(-1)).toEqual(["end", { completed: true, tokensAfter: 185_000 }]);
    expect(warned.join("\n")).toMatch(/host gone/);
  });

  // PLAN-krug 7в.3а-2: whatever breaks after the start, the host hears an end -- not a finished compaction.
  it("запись архива сорвалась -- хост слышит незаконченный конец", async () => {
    const stand = server(20, 5_000);
    const { price } = handle();
    const { engine } = engineOver(stand, price);
    const announce = vi.fn();
    stand.client.commitSession = async () => {
      throw new Error("storage busy");
    };
    await afterTurn(engine, "commit-failed", X, "gemini-3.5-flash-lite", announce);
    expect(announce.mock.calls).toEqual([["start"], ["end", { completed: false }]]);
  });

  it("запись хода после хода объявляет разлив так же", async () => {
    const stand = server(20, 5_000);
    const { price } = handle();
    const { engine } = engineOver(stand, price);
    const announce = vi.fn();
    const result = await engine.commitTurn?.({
      advancementKey: "adv-announce",
      messages: turn("record-announce") as never,
      prePromptMessageCount: 0,
      sessionId: `${SESSION}-record-announce`,
      runtimeContext: { currentTokenCount: X },
      runtimeSettings: { model: { resolved: "gemini-3.5-flash-lite" } },
      announceCompaction: announce,
    } as never);
    expect(result?.status).toBe("committed");
    expect(announce.mock.calls).toEqual([["start"], ["end", { completed: true, tokensAfter: 185_000 }]]);
  });

  it("запись хода после хода отливает так же", async () => {
    const stand = server(20, 5_000);
    const { price } = handle();
    const { engine } = engineOver(stand, price);
    const result = await engine.commitTurn?.({
      advancementKey: "adv-record",
      messages: turn("record") as never,
      prePromptMessageCount: 0,
      sessionId: `${SESSION}-record`,
      runtimeContext: { currentTokenCount: X },
      runtimeSettings: { model: { resolved: "gemini-3.5-flash-lite" } },
    } as never);
    expect(result?.status).toBe("committed");
    expect(stand.commits).toEqual([{ keep_recent_count: 28 }]);
  });
});

/** Сервер с заданными сообщениями (для ходов из трёх сообщений). */
function serverOf(messages: OVMessage[]): Stand {
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
    if (parsed.pathname.endsWith("/messages")) return answer({ session_id: SESSION });
    if (parsed.pathname.endsWith("/commit")) {
      commits.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      return answer({ status: "accepted", archived: true, task_id: "task-1" });
    }
    if (parsed.pathname.endsWith("/context")) {
      return answer({
        latest_archive_overview: "", pre_archive_abstracts: [], messages, estimatedTokens: 1,
        stats: { totalArchives: 0, includedArchives: 0, droppedArchives: 0, failedArchives: 0, activeTokens: 1, archiveTokens: 0, unsummarizedArchives: 0 },
      });
    }
    return answer({ pending_tokens: 0, unsummarized_archives: 0 });
  });
  const client = new OpenVikingClient("http://127.0.0.1:1933", "ov-key", "main", 5_000, "", "", undefined, { transport });
  return { client, commits, asked };
}

/**
 * PLAN-krug 7в.Р2а: новейший архив сорван до записи сводки -- сервер не даёт сводки и ничего не ждёт (случай (б)
 * Р2). Слив заводит новый архив, и до его сводки сервер считает его ждущим; `summaryStood` -- сводка встала.
 */
function serverWithFailedSummary(turns: number, chars: number, waiting = 0) {
  const commits: Array<Record<string, unknown>> = [];
  const asked: string[] = [];
  const messages = Array.from({ length: turns * 2 }, (_, i) => ovMessage(i, chars));
  const state = { waiting, overview: "" };
  const transport: HttpTransport = vi.fn(async (url, init) => {
    const parsed = new URL(url);
    asked.push(`${init?.method ?? "GET"} ${parsed.pathname}`);
    const answer = (body: unknown) =>
      new Response(JSON.stringify({ status: "ok", result: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (parsed.pathname.endsWith("/messages")) return answer({ session_id: SESSION });
    if (parsed.pathname.endsWith("/commit")) {
      commits.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      state.waiting = 1;
      return answer({ status: "accepted", archived: true, task_id: "task-1" });
    }
    if (parsed.pathname.endsWith("/context")) {
      return answer({
        latest_archive_overview: state.overview, pre_archive_abstracts: [], messages, estimatedTokens: 1,
        stats: {
          totalArchives: 2 + commits.length, includedArchives: 0, droppedArchives: 0, failedArchives: 1,
          activeTokens: 1, archiveTokens: 0, unsummarizedArchives: state.waiting,
        },
      });
    }
    if (/\/api\/v1\/sessions\/[^/]+$/.test(parsed.pathname)) {
      return answer({ pending_tokens: 0, unsummarized_archives: state.waiting });
    }
    return new Response(JSON.stringify({ status: "error", error: { code: "NOT_FOUND", message: parsed.pathname } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  });
  const client = new OpenVikingClient("http://127.0.0.1:1933", "ov-key", "main", 5_000, "", "", undefined, { transport });
  return {
    client,
    commits,
    asked,
    summaryStood: () => {
      state.waiting = 0;
      state.overview = "СВОДКА";
    },
  };
}

/** Главная сборка окна того же хода, как её зовёт шлюз. */
async function assembleTurn(engine: ReturnType<typeof engineOver>["engine"], tag: string) {
  await engine.assemble({
    sessionId: `${SESSION}-${tag}`,
    messages: turn(tag) as never,
    tokenBudget: 200_000,
    availableTools: new Set<string>(),
  } as never);
}

// PLAN-krug 7в.Р2а: with the newest archive's summary failed the window is cut to K by the fallback path and
// never reaches X; without a new archive the failed one stays the newest for ever. The server rolls a failed
// archive into the next one's summary, so the turn's end pours below X while that is so.
describe("слив при сорванной сводке (PLAN-krug 7в.Р2а)", () => {
  it("ниже X, остаток тяжелее K -- слив с хвостом под K", async () => {
    // 20 ходов по два сообщения в 5 000 знаков (все -- 200 001 с «x»): не тяжелее 150 000 -- 14 ходов (140 001).
    const stand = serverWithFailedSummary(20, 5_000);
    const { price } = handle();
    const { engine, diags } = engineOver(stand, price);

    await assembleTurn(engine, "failed");
    await afterTurn(engine, "failed", 160_000);

    expect(stand.commits).toEqual([{ keep_recent_count: 28 }]);
    expect(lastDiag(diags, "pour_off")).toMatchObject({
      trigger: "failed_summary", window: 160_000, rest: 0, cap: K, keptMessages: 28, archivedMessages: 12,
    });
  });

  it("остаток не тяжелее K -- слива нет, и каждый ход об этом не кричит", async () => {
    const stand = serverWithFailedSummary(5, 10_000);
    const { price } = handle();
    const { engine, diags, warned } = engineOver(stand, price);

    await assembleTurn(engine, "light-failed");
    await afterTurn(engine, "light-failed", 160_000);

    expect(stand.commits).toEqual([]);
    expect(lastDiag(diags, "pour_skip")).toMatchObject({ reason: "nothing_to_pour", failedSummary: true });
    expect(warned.join("\n")).not.toMatch(/nothing to pour/);
  });

  it("ручка молчит -- слива нет, и следующий ход его не ждёт", async () => {
    const stand = serverWithFailedSummary(20, 10_000);
    const silent = { url: "http://127.0.0.1:8787/price", price: async () => null };
    const { engine, diags } = engineOver(stand, silent);

    await assembleTurn(engine, "silent-failed");
    await afterTurn(engine, "silent-failed", 160_000);
    await assembleTurn(engine, "silent-failed");

    expect(stand.commits).toEqual([]);
    expect(lastDiag(diags, "pour_skip")).toMatchObject({ reason: "no_weight", failedSummary: true });
    expect(diags.filter((d) => d.stage === "pour_hold")).toEqual([]);
  });

  // НР-3: the whole remainder under the cap is the answer already -- the search would ask the handle about shorter
  // tails at every turn's end only to find the same.
  it("остаток не тяжелее K -- ручку спрашивают один раз", async () => {
    // 12 ходов по два сообщения в 5 000 знаков: все -- 120 001, планка 20 пройдена.
    const stand = serverWithFailedSummary(12, 5_000);
    const { price, bodies } = handle();
    const { engine } = engineOver(stand, price);

    await assembleTurn(engine, "one-ask");
    await afterTurn(engine, "one-ask", 160_000);

    expect(stand.commits).toEqual([]);
    expect(bodies).toHaveLength(1);
  });

  // НР-4: the window holds a tail cut to K, not the server's remainder, so the window less the remainder is not
  // the window's constant part; the host keeps its own measure of the window.
  it("слив объявляется хосту без веса окна после", async () => {
    const stand = serverWithFailedSummary(20, 5_000);
    const { price } = handle();
    const { engine, warned } = engineOver(stand, price);
    const announce = vi.fn();

    await assembleTurn(engine, "announce-failed");
    await afterTurn(engine, "announce-failed", 160_000, "gemini-3.5-flash-lite", announce);

    expect(stand.commits).toEqual([{ keep_recent_count: 28 }]);
    expect(announce.mock.calls).toEqual([["start"], ["end", { completed: true }]]);
    expect(warned.join("\n")).not.toMatch(/without a weight of the window after/);
  });

  it("сводка встала между сборкой и концом хода -- слив решает ответ на конец хода", async () => {
    const stand = serverWithFailedSummary(20, 5_000);
    const { price } = handle();
    const { engine, diags } = engineOver(stand, price);

    await assembleTurn(engine, "stale-mark");
    stand.summaryStood();
    await afterTurn(engine, "stale-mark", 160_000);

    expect(stand.commits).toEqual([]);
    expect(lastDiag(diags, "pour_skip")).toMatchObject({ reason: "below_x" });
  });

  it("архив ждёт своей сводки -- это не сорванная: ниже X ответ в конце хода не читается", async () => {
    const stand = serverWithFailedSummary(20, 5_000, 1);
    const { price } = handle();
    const { engine, diags } = engineOver(stand, price, 20, { holdForSummarySeconds: 0 });

    await assembleTurn(engine, "waiting");
    const readsBefore = stand.asked.filter((line) => line.endsWith("/context")).length;
    await afterTurn(engine, "waiting", 160_000);

    expect(stand.asked.filter((line) => line.endsWith("/context")).length).toBe(readsBefore);
    expect(lastDiag(diags, "pour_skip")).toMatchObject({ reason: "below_x" });
  });

  it("сводка встала -- ниже X ответ сервера в конце хода снова не читается", async () => {
    const stand = serverWithFailedSummary(20, 10_000);
    const { price } = handle();
    const { engine, diags } = engineOver(stand, price);

    await assembleTurn(engine, "stood");
    stand.summaryStood();
    await assembleTurn(engine, "stood");
    const readsBefore = stand.asked.filter((line) => line.endsWith("/context")).length;
    await afterTurn(engine, "stood", 160_000);

    expect(stand.asked.filter((line) => line.endsWith("/context")).length).toBe(readsBefore);
    expect(stand.commits).toEqual([]);
    expect(lastDiag(diags, "pour_skip")).toMatchObject({ reason: "below_x" });
  });
});
