import { describe, expect, it, vi } from "vitest";
import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, type OVMessage } from "../client.js";
import { assembleOpenVikingSession } from "../services/context-lifecycle-service.js";
import type { AgentMessage } from "../services/context-message-adapter.js";
import { estimateAgentMessagesTokens } from "../token-estimator.js";

/*
 * Ход держится, пока сводка не встала (PLAN-gorizont 4д; файл 35 шлюза).
 *
 * После разлива сводка архива пишется на сервере в фоне, а следующий ход начинался
 * сразу: сервер отдавал сырые сообщения архива, и ход шёл у потолка. Теперь главная
 * сборка контекста, увидев, что сводка ещё пишется, говорит хосту «сжатие началось»,
 * ждёт сводку до предела и читает контекст заново уже с ней; хост показывает это
 * клиентам как своё сжатие. Предел вышел -- ход идёт как шёл, и до тех пор, пока
 * сводка не встанет, следующие ходы той же сессии не ждут снова.
 */
const PADDING = " слово".repeat(40);

function ovMessage(i: number): OVMessage {
  return {
    id: `ov-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `[m${String(i).padStart(3, "0")}]${PADDING}` }],
    created_at: new Date(Date.UTC(2026, 9, 10, 0, i)).toISOString(),
  };
}

function liveTranscript(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `[m${String(i).padStart(3, "0")}]${PADDING}`,
    timestamp: Date.UTC(2026, 9, 10, 0, i),
  }));
}

/** The server: the context says how many archives wait for a summary, the session
 * says the same when asked again; each list is read front to back, the last value
 * stays. */
function server(answers: { context: number[]; session: number[] }) {
  const asked: string[] = [];
  const next = (list: number[]) => (list.length > 1 ? (list.shift() as number) : (list[0] as number));
  const transport: HttpTransport = vi.fn(async (url) => {
    const parsed = new URL(url);
    asked.push(parsed.pathname);
    const answer = (body: unknown) =>
      new Response(JSON.stringify({ status: "ok", result: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (parsed.pathname.endsWith("/context")) {
      const waiting = next(answers.context);
      return answer({
        latest_archive_overview: waiting > 0 ? "" : "СВОДКА",
        pre_archive_abstracts: [],
        messages: [ovMessage(0), ovMessage(1)],
        estimatedTokens: 1,
        stats: {
          totalArchives: 1, includedArchives: waiting > 0 ? 0 : 1, droppedArchives: 0,
          failedArchives: 0, activeTokens: 1, archiveTokens: 1, unsummarizedArchives: waiting,
        },
      });
    }
    if (/\/sessions\/[^/]+$/.test(parsed.pathname)) {
      return answer({ message_count: 2, unsummarized_archives: next(answers.session) });
    }
    return new Response(JSON.stringify({ status: "error", error: { code: "NOT_FOUND", message: parsed.pathname } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  });
  const client = new OpenVikingClient("http://127.0.0.1:1933", "ov-key", "main", 5_000, "", "", undefined, {
    transport,
  });
  return {
    client,
    contextReads: () => asked.filter((path) => path.endsWith("/context")).length,
    sessionPolls: () => asked.filter((path) => /\/sessions\/[^/]+$/.test(path)).length,
  };
}

function stand(sessionId: string, client: OpenVikingClient, cfg: Record<string, unknown>) {
  const announce = vi.fn();
  const seen: Array<{ stage: string; data: Record<string, unknown> }> = [];
  const logger = { info: vi.fn(), warn: vi.fn() };
  const assemble = (extra: { isMainAssemble?: boolean } = {}) =>
    assembleOpenVikingSession({
      sessionId,
      messages: liveTranscript(2),
      tokenBudget: 20_000,
      isMainAssemble: extra.isMainAssemble ?? true,
      cfg: { autoRecall: false, holdForSummarySeconds: 5, ...cfg },
      getClient: async () => client,
      logger,
      resolveAgentId: () => "main",
      isBypassedSession: () => false,
      diag: (stage, _session, data) => seen.push({ stage, data }),
      roughEstimate: estimateAgentMessagesTokens,
      messageDigest: () => [],
      extractAgentMessageText: () => "",
      hasAutoRecallBlock: () => false,
      prependRecallToLatestUserMessage: (list) => list,
      pollIntervalMs: 1,
      announceCompaction: announce,
    });
  return { assemble, announce, seen, logger, holds: () => seen.filter((entry) => entry.stage === "hold_for_summary") };
}

describe("ход держится, пока сводка не встала", () => {
  it("ждёт сводку, объявляя сжатие хосту, и читает контекст заново уже с ней", async () => {
    const { client, contextReads, sessionPolls } = server({ context: [1, 0], session: [1, 1, 0] });
    const { assemble, announce, holds } = stand("11111111-0000-4000-8000-000000000001", client, {});

    await assemble();

    expect(announce.mock.calls).toEqual([["start"], ["end", { completed: true }]]);
    expect(sessionPolls()).toBeGreaterThanOrEqual(3);
    // The context is read twice: once to see the summary still being written, once with it.
    expect(contextReads()).toBe(2);
    expect(holds()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ outcome: "stands", unsummarizedArchives: 1, polls: 3 }),
      }),
    ]);
  });

  it("предел вышел -- идёт на сырых сообщениях и не ждёт снова, пока сводка не встанет", async () => {
    const { client, contextReads, sessionPolls } = server({ context: [1, 1, 0, 1, 0], session: [1] });
    const { assemble, announce, seen, holds } = stand("11111111-0000-4000-8000-000000000002", client, {
      holdForSummarySeconds: 0.02,
    });

    await assemble();
    expect(announce.mock.calls).toEqual([["start"], ["end", { completed: false }]]);
    expect(contextReads()).toBe(1);
    expect(holds()).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ outcome: "timeout" }) }),
    ]);
    const pollsAfterFirst = sessionPolls();
    expect(pollsAfterFirst).toBeGreaterThanOrEqual(1);

    // The next turn, the summary still being written: no second hold, no polls.
    announce.mockClear();
    await assemble();
    expect(announce).not.toHaveBeenCalled();
    expect(sessionPolls()).toBe(pollsAfterFirst);
    expect(seen.filter((entry) => entry.stage === "hold_for_summary_skip")).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ reason: "gave_up_before" }) }),
    ]);

    // The summary stood (nothing waits): the memory of giving up is cleared, so the
    // next pour's summary is waited for again.
    await assemble();
    expect(announce).not.toHaveBeenCalled();
    await assemble();
    expect(announce.mock.calls).toEqual([["start"], ["end", { completed: false }]]);
  });

  it("не ждёт, когда ничто не ждёт сводки", async () => {
    const { client, contextReads, sessionPolls } = server({ context: [0], session: [0] });
    const { assemble, announce } = stand("11111111-0000-4000-8000-000000000003", client, {});

    await assemble();

    expect(announce).not.toHaveBeenCalled();
    expect(sessionPolls()).toBe(0);
    expect(contextReads()).toBe(1);
  });

  it("предел в ноль секунд -- ожидания нет", async () => {
    const { client, sessionPolls } = server({ context: [1], session: [1] });
    const { assemble, announce, seen } = stand("11111111-0000-4000-8000-000000000004", client, {
      holdForSummarySeconds: 0,
    });

    await assemble();

    expect(announce).not.toHaveBeenCalled();
    expect(sessionPolls()).toBe(0);
    expect(seen.filter((entry) => entry.stage.startsWith("hold_for_summary"))).toEqual([]);
  });

  it("без ручки хоста ждёт молча", async () => {
    const { client, contextReads } = server({ context: [1, 0], session: [1, 0] });
    const seen: Array<{ stage: string }> = [];
    await assembleOpenVikingSession({
      sessionId: "11111111-0000-4000-8000-000000000005",
      messages: liveTranscript(2),
      tokenBudget: 20_000,
      isMainAssemble: true,
      cfg: { autoRecall: false, holdForSummarySeconds: 5 },
      getClient: async () => client,
      logger: { info: () => {}, warn: () => {} },
      resolveAgentId: () => "main",
      isBypassedSession: () => false,
      diag: (stage) => seen.push({ stage }),
      roughEstimate: estimateAgentMessagesTokens,
      messageDigest: () => [],
      extractAgentMessageText: () => "",
      hasAutoRecallBlock: () => false,
      prependRecallToLatestUserMessage: (list) => list,
      pollIntervalMs: 1,
    });
    expect(contextReads()).toBe(2);
    expect(seen.some((entry) => entry.stage === "hold_for_summary")).toBe(true);
  });
});
