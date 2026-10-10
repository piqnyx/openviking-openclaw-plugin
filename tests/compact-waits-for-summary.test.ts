import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, type OVMessage } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";
import type { PriceVerdict } from "../price-handle.js";

/*
 * Сжатие по просьбе шлюза (PLAN-gorizont, 4в).
 *
 * Шлюз зовёт compact двумя способами: автоматически, с пометкой «budget» -- перед ходом у края
 * окна и по страховке, когда прокси отверг запрос как переполнение; и руками, /compact, с
 * пометкой «threshold». Плагин отвечает «сжато», как только сводка записана и стоит в контексте,
 * не дожидаясь извлечения долгой памяти, которое сервер доделывает в фоне.
 *
 * Правда о сводке -- у сервера: число архивов, ждущих сводки, в его ответе о сессии. После
 * коммита оно единица, после записи сводки -- ноль. Стадия задачи в словах для этого не годится:
 * извлечение идёт параллельно и перезаписывает её. Провал задачи до сводки -- провал сжатия;
 * срок вышел -- провал сжатия, шлюз роняет ход, следующий запрос попробует снова.
 *
 * Автоматическое сжатие оставляет хвост по K тем же резаком, что отливание; если сводка прошлого
 * отливания ещё пишется, нового архива не делает, а ждёт её: окно уменьшится само. Ручной
 * /compact сворачивает всё.
 */

const SESSION = "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3";
const X = 245_000;
const K = 150_000;

type State = {
  unsummarized: number | null;
  sessionPolls: number;
  /** После скольких опросов сессии сводка встаёт (счётчик становится нулём); null -- никогда. */
  standsAfterPolls: number | null;
  overview: string;
  task: { status: string; stage?: string; error?: string };
  archivedOnCommit: boolean;
  messages: OVMessage[];
};

type Stand = { client: OpenVikingClient; commits: Array<Record<string, unknown>>; state: State; asked: string[] };

function ovMessage(i: number, chars: number): OVMessage {
  return {
    id: `ov-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `[m${String(i).padStart(3, "0")}]`.padEnd(chars, "а") }],
    created_at: new Date(Date.UTC(2026, 9, 7, 0, i)).toISOString(),
  };
}

function server(turns: number, chars: number, given: Partial<State> = {}): Stand {
  const state: State = {
    unsummarized: 0,
    sessionPolls: 0,
    standsAfterPolls: 2,
    overview: "СВОДКА-СТАРАЯ",
    task: { status: "running", stage: "archive_read" },
    archivedOnCommit: true,
    messages: Array.from({ length: turns * 2 }, (_, i) => ovMessage(i, chars)),
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
    if (parsed.pathname.endsWith("/commit")) {
      commits.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      if (!state.archivedOnCommit) {
        return answer({ status: "skipped", archived: false, reason: "all_within_keep_window" });
      }
      if (state.unsummarized !== null) {
        state.unsummarized += 1;
      }
      state.sessionPolls = 0;
      return answer({ status: "accepted", archived: true, task_id: "task-1", archive_uri: "viking://s/history/archive_007" });
    }
    if (parsed.pathname.endsWith("/context")) {
      return answer({
        latest_archive_overview: state.overview,
        pre_archive_abstracts: [],
        messages: state.messages,
        estimatedTokens: 4_000,
        stats: {
          totalArchives: 1, includedArchives: 1, droppedArchives: 0, failedArchives: 0,
          activeTokens: 1, archiveTokens: 1,
          ...(state.unsummarized === null ? {} : { unsummarizedArchives: state.unsummarized }),
        },
      });
    }
    if (/\/api\/v1\/tasks\/[^/]+$/.test(parsed.pathname)) {
      return answer({ task_id: "task-1", task_type: "session_commit", created_at: 0, updated_at: 0, ...state.task });
    }
    if (/\/api\/v1\/sessions\/[^/]+$/.test(parsed.pathname)) {
      state.sessionPolls += 1;
      if (
        state.standsAfterPolls !== null &&
        state.unsummarized !== null &&
        state.unsummarized > 0 &&
        state.sessionPolls >= state.standsAfterPolls
      ) {
        state.unsummarized = 0;
        state.overview = "СВОДКА-НОВАЯ";
        state.messages = state.messages.slice(-4);
      }
      return answer({
        pending_tokens: 0,
        ...(state.unsummarized === null ? {} : { unsummarized_archives: state.unsummarized }),
      });
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

function handle() {
  return {
    url: "http://127.0.0.1:8787/price",
    price: async (body: Record<string, unknown>): Promise<PriceVerdict | null> => {
      const typed = body as { model: string; messages: Array<{ content: unknown }> };
      const charge = typed.messages.reduce(
        (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
        0,
      );
      return { model: typed.model, charge, ours: charge, google: null, surcharge: 0, ceiling: 249_000, fits: true };
    },
  };
}

function engineOver(
  stand: Stand,
  options: {
    priced?: boolean;
    keepRecentFloor?: number;
    compactWaitSeconds?: number;
    /** Свои весы вместо обычных (например, молчащие). */
    handle?: ReturnType<typeof handle>;
  } = {},
) {
  const warned: string[] = [];
  const diags: Array<{ stage: string; data: Record<string, unknown> }> = [];
  const engine = createMemoryOpenVikingContextEngine({
    id: "openviking",
    name: "OpenViking",
    cfg: memoryOpenVikingConfigSchema.parse({
      baseUrl: "http://127.0.0.1:1933",
      autoRecall: false,
      emitStandardDiagnostics: true,
      pourOffAtTokens: X,
      keepRecentTokens: K,
      keepRecentFloor: options.keepRecentFloor ?? 20,
      compactWaitSeconds: options.compactWaitSeconds ?? 5,
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
    ...(options.priced === false ? {} : { priceHandle: options.handle ?? handle() }),
    pollIntervalMs: 1,
  });
  return { engine, warned, diags };
}

async function compact(
  engine: ReturnType<typeof engineOver>["engine"],
  compactionTarget: "budget" | "threshold",
  currentTokenCount: number | undefined = X,
) {
  return await engine.compact({
    sessionId: SESSION,
    sessionFile: "/tmp/compact.jsonl",
    tokenBudget: 249_000,
    ...(currentTokenCount === undefined ? {} : { currentTokenCount }),
    compactionTarget,
    runtimeSettings: { model: { resolved: "gemini-3.5-flash-lite", requested: null } },
  } as never);
}

describe("ручной /compact", () => {
  it("сворачивает всё и отвечает «сжато», когда сводка встала", async () => {
    const stand = server(20, 5_000);
    const { engine } = engineOver(stand);
    const result = await compact(engine, "threshold");

    expect(stand.commits).toEqual([{}]);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("summary_stands");
    expect(result.result?.summary).toBe("СВОДКА-НОВАЯ");
    expect(stand.state.sessionPolls).toBeGreaterThanOrEqual(2);
  });

  it("серверу нечего сворачивать -- как раньше, без сжатия", async () => {
    const stand = server(0, 10, { archivedOnCommit: false });
    const { engine } = engineOver(stand);
    const result = await compact(engine, "threshold");

    expect(stand.commits).toEqual([{}]);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("commit_no_archive");
  });
});

describe("автоматическое сжатие", () => {
  it("оставляет хвост по K тем же резаком и ждёт сводку", async () => {
    // 20 ходов по 5 000 знаков: под 150 000 -- 14 ходов (140 001), как при отливании.
    const stand = server(20, 5_000);
    const { engine, diags } = engineOver(stand);
    const result = await compact(engine, "budget");

    expect(stand.commits).toEqual([{ keep_recent_count: 28 }]);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("summary_stands");
    expect(result.result?.summary).toBe("СВОДКА-НОВАЯ");
    expect(result.result?.firstKeptEntryId).toBe("archive_007");
    expect(diags.filter((d) => d.stage === "compact_result").at(-1)?.data).toMatchObject({
      ok: true, compacted: true, reason: "summary_stands", keptMessages: 28, keptWeight: 140_001, waitedPolls: 2,
    });
  });

  it("K -- верхняя планка и здесь: не больше, чем влезает под X с постоянной частью", async () => {
    const stand = server(10, 1_000);
    const { engine } = engineOver(stand, { keepRecentFloor: 4 });
    const result = await compact(engine, "budget", 250_000);

    expect(stand.commits).toEqual([{ keep_recent_count: 14 }]);
    expect(result.compacted).toBe(true);
  });

  it("сводка прошлого отливания ещё пишется: нового архива не делает, ждёт её", async () => {
    const stand = server(20, 5_000, { unsummarized: 1, standsAfterPolls: 3 });
    const { engine } = engineOver(stand);
    const result = await compact(engine, "budget");

    expect(stand.commits).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("previous_pour_summary_stands");
    expect(result.result?.summary).toBe("СВОДКА-НОВАЯ");
    expect(stand.state.sessionPolls).toBeGreaterThanOrEqual(3);
  });

  it("всё влезает под cap: «уже сжато», сервер не трогается", async () => {
    const stand = server(10, 1_000);
    const { engine } = engineOver(stand, { keepRecentFloor: 4 });
    const result = await compact(engine, "budget", X);

    expect(stand.commits).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(String(result.reason)).toMatch(/already compacted/i);
  });

  it("сервер отвечает, что сворачивать нечего: «уже сжато»", async () => {
    const stand = server(20, 5_000, { archivedOnCommit: false });
    const { engine } = engineOver(stand);
    const result = await compact(engine, "budget");

    expect(stand.commits).toEqual([{ keep_recent_count: 28 }]);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(String(result.reason)).toMatch(/already compacted/i);
  });

  // PLAN-gorizont 5а (11.10): весы молчат -- сжатия нет, провал с причиной; пола «не
  // влезает» больше нет, число не от счётчика брать нельзя.
  it("весы молчат -- провал сжатия с причиной no_weight, сервер не трогается", async () => {
    const stand = server(20, 5_000);
    const silent = {
      url: "http://127.0.0.1:8787/price",
      price: async (): Promise<PriceVerdict | null> => null,
    };
    const { engine, diags } = engineOver(stand, { handle: silent });
    const result = await compact(engine, "budget");

    expect(stand.commits).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("no_weight");
    expect(diags.filter((d) => d.stage === "compact_result").at(-1)?.data).toMatchObject({
      ok: false, compacted: false, reason: "no_weight",
    });
  });

  it("без ручки хвост по планке, с предупреждением", async () => {
    const stand = server(20, 5_000);
    const { engine, warned } = engineOver(stand, { priced: false });
    const result = await compact(engine, "budget");

    expect(stand.commits).toEqual([{ keep_recent_count: 20 }]);
    expect(result.compacted).toBe(true);
    expect(warned.join("\n")).toMatch(/without a price/);
  });
});

describe("когда сводка не встаёт", () => {
  it("задача сорвалась до сводки -- провал сжатия", async () => {
    const stand = server(20, 5_000, {
      standsAfterPolls: null,
      task: { status: "failed", error: "long_term_memory_extraction: 0 of 40 messages done; broken json" },
    });
    const { engine } = engineOver(stand);
    const result = await compact(engine, "budget");

    expect(stand.commits).toEqual([{ keep_recent_count: 28 }]);
    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("commit_failed");
    expect(JSON.stringify(result.result?.details)).toContain("broken json");
  });

  it("срок вышел -- провал сжатия, шлюз попробует снова", async () => {
    const stand = server(20, 5_000, { standsAfterPolls: null });
    const { engine, warned } = engineOver(stand, { compactWaitSeconds: 0.01 });
    const result = await compact(engine, "budget");

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("summary_timeout");
    expect(warned.join("\n")).toMatch(/summary/);
  });

  it("срок вышел, пока ждали сводку прошлого отливания -- тоже провал", async () => {
    const stand = server(20, 5_000, { unsummarized: 1, standsAfterPolls: null });
    const { engine } = engineOver(stand, { compactWaitSeconds: 0.01 });
    const result = await compact(engine, "budget");

    expect(stand.commits).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("summary_timeout");
  });

  it("сервер без счётчика: ждёт, как раньше, конца задачи", async () => {
    const stand = server(20, 5_000, { unsummarized: null, task: { status: "completed" } });
    const { engine, warned } = engineOver(stand);
    const result = await compact(engine, "threshold");

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(warned.join("\n")).toMatch(/unsummarized_archives/);
  });
});
