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

/** Сервер: столько ходов по два сообщения, каждое из `chars` знаков; счётчик висящих без сводки. */
function server(turns: number, chars: number, unsummarized: number | undefined = 0): Stand {
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
      return answer({ status: "accepted", archived: true, task_id: "task-1" });
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
          ...(unsummarized === undefined ? {} : { unsummarizedArchives: unsummarized }),
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

function engineOver(stand: Stand, priceHandle: ReturnType<typeof handle>["price"] | undefined, keepRecentFloor = 20) {
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

async function afterTurn(
  engine: ReturnType<typeof engineOver>["engine"],
  tag: string,
  window: number | undefined,
  model: string | undefined = "gemini-3.5-flash-lite",
) {
  await engine.afterTurn?.({
    sessionId: `${SESSION}-${tag}`,
    sessionFile: `/tmp/${tag}.jsonl`,
    messages: turn(tag) as never,
    prePromptMessageCount: 0,
    runtimeContext: window === undefined ? {} : { currentTokenCount: window },
    ...(model === undefined ? {} : { runtimeSettings: { model: { resolved: model, requested: model } } }),
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
    // 20 ходов по два сообщения в 10 000 знаков: ход весит 20 000; не тяжелее 150 000 -- семь ходов.
    const stand = server(20, 10_000);
    const { price, bodies } = handle();
    const { engine, diags, warned } = engineOver(stand, price);
    await afterTurn(engine, "at-x", X);
    expect(stand.commits).toEqual([{ keep_recent_count: 14 }]);
    expect(warned).toEqual([]);
    // Вес всех плюс двоичный поиск по границам: не больше семи обращений.
    expect(bodies.length).toBeLessThanOrEqual(7);
    for (const body of bodies) {
      expect(body.model).toBe("gemini-3.5-flash-lite");
      expect(body.messages.at(-1)).toEqual({ role: "user", content: "x" });
    }
    expect(lastDiag(diags, "pour_off")).toMatchObject({
      window: X,
      cap: K,
      keptMessages: 14,
      keptWeight: 140_001,
      archivedMessages: 26,
      taskId: "task-1",
    });
    expect(stand.asked.filter((line) => line.includes("/context"))).toEqual([
      `GET /api/v1/sessions/${SESSION}-at-x/context?token_budget=1000000000`,
    ]);
  });

  it("K -- верхняя планка: остаётся не больше, чем влезает под X с постоянной частью окна", async () => {
    // Десять ходов по два сообщения в 1 000 знаков: все вместе 20 001, постоянная часть окна
    // 245 000 − 20 001 = 224 999, под X остаётся 20 000 -- девять ходов (18 001), не десять (20 001).
    const stand = server(10, 1_000);
    const { price } = handle();
    const { engine, diags } = engineOver(stand, price);
    await afterTurn(engine, "cap", X);
    expect(stand.commits).toEqual([{ keep_recent_count: 18 }]);
    expect(lastDiag(diags, "pour_off")).toMatchObject({ rest: 224_999, cap: 20_000, keptMessages: 18 });
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
    const stand = server(20, 10_000, undefined);
    const { price } = handle();
    const { engine, warned } = engineOver(stand, price);
    await afterTurn(engine, "old-server", X);
    expect(stand.commits).toEqual([{ keep_recent_count: 14 }]);
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
    await afterTurn(engine, "no-model", X, undefined);
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

  it("запись хода после хода отливает так же", async () => {
    const stand = server(20, 10_000);
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
    expect(stand.commits).toEqual([{ keep_recent_count: 14 }]);
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
