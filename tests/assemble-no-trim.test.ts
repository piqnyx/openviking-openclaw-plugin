import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, type OVMessage } from "../client.js";
import { assembleOpenVikingSession } from "../services/context-lifecycle-service.js";
import type { AgentMessage } from "../services/context-message-adapter.js";
import { estimateAgentMessagesTokens } from "../token-estimator.js";

/*
 * Окно по точному весу, без обрезки по оценке (PLAN-gorizont, 4а).
 *
 * Граница живого окна и архива -- у сервера Викинга: что не ушло в архив, то в окне, целиком.
 * Раньше плагин резал сообщения сервера по своей оценке (знаки на четыре) под бюджет шлюза, а
 * сервер резал их по своей -- обе оценки не в единицах счётчика прокси, и обе могли выкинуть то,
 * что по счётчику помещалось. Теперь плагин не режет ничего, а сервер получает бюджет, при
 * котором не режет и он. Сколько весит окно, знает только счётчик прокси; по нему плагин и
 * отливает (4б).
 */

const PADDING = " слово".repeat(400);

function ovMessage(i: number): OVMessage {
  return {
    id: `ov-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `[m${String(i).padStart(3, "0")}]${PADDING}` }],
    created_at: new Date(Date.UTC(2026, 9, 7, 0, i)).toISOString(),
  };
}

function liveTranscript(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `[m${String(i).padStart(3, "0")}]${PADDING}`,
    timestamp: Date.UTC(2026, 9, 7, 0, i),
  }));
}

function server(messages: OVMessage[]) {
  const asked: string[] = [];
  const transport: HttpTransport = vi.fn(async (url) => {
    const parsed = new URL(url);
    asked.push(`${parsed.pathname}${parsed.search}`);
    const answer = (body: unknown) =>
      new Response(JSON.stringify({ status: "ok", result: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (parsed.pathname.endsWith("/context")) {
      return answer({
        latest_archive_overview: "СВОДКА",
        pre_archive_abstracts: [],
        messages,
        estimatedTokens: 1,
        stats: {
          totalArchives: 2, includedArchives: 1, droppedArchives: 0,
          failedArchives: 0, activeTokens: 1, archiveTokens: 1, unsummarizedArchives: 0,
        },
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
  return { client, asked };
}

describe("окно без обрезки по оценке", () => {
  it("все сообщения сервера идут в окно, каким бы ни был бюджет шлюза, и сервер не режет тоже", async () => {
    const count = 80;
    const { client, asked } = server(Array.from({ length: count }, (_, i) => ovMessage(i)));
    const live = liveTranscript(count);
    const budget = 20_000;
    expect(estimateAgentMessagesTokens(live)).toBeGreaterThan(budget * 2);
    const seen: Array<{ stage: string; data: Record<string, unknown> }> = [];

    const result = await assembleOpenVikingSession({
      sessionId: "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3",
      messages: live,
      tokenBudget: budget,
      isMainAssemble: true,
      cfg: { autoRecall: false },
      getClient: async () => client,
      logger: { info: () => {}, warn: () => {} },
      resolveAgentId: () => "main",
      isBypassedSession: () => false,
      diag: (stage, _session, data) => seen.push({ stage, data }),
      roughEstimate: estimateAgentMessagesTokens,
      messageDigest: () => [],
      extractAgentMessageText: () => "",
      hasAutoRecallBlock: () => false,
      prependRecallToLatestUserMessage: (list) => list,
    });

    const marks = JSON.stringify(result.messages).match(/\[m\d{3}\]/g) ?? [];
    expect(marks).toEqual(Array.from({ length: count }, (_, i) => `[m${String(i).padStart(3, "0")}]`));
    expect(JSON.stringify(result.messages[0])).toContain("[Session History Summary]\\nСВОДКА");
    expect(result.estimatedTokens).toBeGreaterThan(budget);
    expect(asked).toEqual(["/api/v1/sessions/9478e347-6bdc-44f5-a4e0-207fe7e4b6e3/context?token_budget=1000000000"]);
    const outcome = seen.filter((s) => s.stage === "assemble_result").at(-1)?.data ?? {};
    expect(outcome.activeCount).toBe(count);
    // The summary is a user message, and the provider sanitizer joins it with the
    // first user message of the server, so the count stays at the server's.
    expect(outcome.outputMessagesCount).toBe(count);
  });
});
