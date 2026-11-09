import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, type OVMessage, type OVMessagePart } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";
import type { SessionTranscriptReader } from "../services/branch-reader.js";
import type { BranchRow } from "../services/transcript-catch-up.js";

/*
 * PLAN-krug Р1, шаг 7б, через движок, как его зовёт шлюз: с читателем переписки шлюза
 * (`runtimeContext.readSessionTranscript`) запись хода -- «догнать» по номерам строк: хук посреди
 * хода пишет вопрос и выдачи инструментов, очередь в конце хода -- ответ; повтор ничего не
 * дублирует; слив по X после записи идёт, как шёл. Без читателя (шлюз старее) -- прежняя запись
 * и одно громкое предупреждение на процесс.
 */

// A session of its own for each test: the old turn fingerprints are claimed process-wide (7д removes them).
let SESSION = randomUUID();
const KEY = "agent:main:telegram:direct:1";
const T0 = Date.UTC(2026, 10, 9, 10, 0, 0);

type Stored = OVMessage & { source_message_ids?: string[] };

function server() {
  const stored: Stored[] = [];
  const commits: unknown[] = [];
  const transport: HttpTransport = vi.fn(async (url, init) => {
    const parsed = new URL(url);
    const answer = (body: unknown) =>
      new Response(JSON.stringify({ status: "ok", result: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (parsed.pathname.endsWith("/messages") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        role: string;
        parts: OVMessagePart[];
        created_at?: string;
        source_message_ids?: string[];
      };
      stored.push({
        id: `ov-${stored.length + 1}`,
        role: body.role,
        parts: body.parts,
        created_at: body.created_at ?? "",
        ...(body.source_message_ids ? { source_message_ids: body.source_message_ids } : {}),
      });
      return answer({ session_id: SESSION });
    }
    if (parsed.pathname.endsWith("/context")) {
      return answer({
        latest_archive_overview: "",
        pre_archive_abstracts: [],
        messages: stored,
        estimatedTokens: 1,
        stats: { totalArchives: 0, includedArchives: 0, droppedArchives: 0, failedArchives: 0, activeTokens: 1, archiveTokens: 0, unsummarizedArchives: 0 },
      });
    }
    if (parsed.pathname.endsWith("/commit")) {
      commits.push(JSON.parse(String(init?.body ?? "{}")));
      return answer({ status: "skipped", archived: false });
    }
    return answer({ pending_tokens: 0, unsummarized_archives: 0 });
  });
  const client = new OpenVikingClient("http://127.0.0.1:1933", "ov-key", "main", 5_000, "", "", undefined, { transport });
  return { client, stored, commits, transport: transport as unknown as ReturnType<typeof vi.fn> };
}

function engineOver(stand: ReturnType<typeof server>) {
  const warned: string[] = [];
  const diags: Array<{ stage: string; data: Record<string, unknown> }> = [];
  const engine = createMemoryOpenVikingContextEngine({
    id: "openviking",
    name: "OpenViking",
    cfg: memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", autoRecall: false, emitStandardDiagnostics: true }),
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
  });
  return { engine, warned, diags };
}

function row(id: string, message: Record<string, unknown>): BranchRow {
  return { entryId: id, firstEntryId: id, message };
}

/** The gateway's reader over the branch as it stands now. */
function readerOver(branch: BranchRow[]): SessionTranscriptReader {
  return {
    readVisiblePage: async (limits) => {
      const start = limits?.cursor ? Number(limits.cursor) : 0;
      return { kind: "page", cursor: String(branch.length), rows: branch.slice(start), hasMore: false };
    },
    selectModelVisible: (rows) => rows,
  };
}

const question = row("u1", { role: "user", content: "погода?", timestamp: T0 });
const call = row("c1", {
  role: "assistant",
  content: [{ type: "toolCall", id: "call-1", name: "web_search", arguments: { query: "погода" } }],
  timestamp: T0 + 1_000,
});
const result = row("r1", {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "web_search",
  content: [{ type: "text", text: "дождь" }],
  timestamp: T0 + 2_000,
});
const reply = row("a1", { role: "assistant", content: [{ type: "text", text: "будет дождь" }], timestamp: T0 + 3_000 });

async function hookWith(engine: ReturnType<typeof engineOver>["engine"], branch: BranchRow[], extra: Record<string, unknown> = {}) {
  await engine.afterTurn?.({
    sessionId: SESSION,
    sessionFile: "/tmp/s.jsonl",
    messages: branch.map((candidate) => candidate.message) as never,
    prePromptMessageCount: 0,
    runtimeContext: { sessionKey: KEY, senderId: "1", readSessionTranscript: readerOver(branch), ...extra },
  } as never);
}

async function queueWith(engine: ReturnType<typeof engineOver>["engine"], branch: BranchRow[], key: string, extra: Record<string, unknown> = {}) {
  return await engine.commitTurn?.({
    advancementKey: key,
    messages: branch.map((candidate) => candidate.message) as never,
    sessionId: SESSION,
    sessionKey: KEY,
    runtimeContext: { readSessionTranscript: readerOver(branch), ...extra },
  } as never);
}

describe("запись хода через «догнать», как зовёт шлюз", () => {
  beforeEach(() => {
    SESSION = randomUUID();
  });

  it("хук пишет вопрос и выдачи по номерам строк, очередь -- ответ; повтор ничего не дублирует", async () => {
    const stand = server();
    const { engine } = engineOver(stand);

    await hookWith(engine, [question, call, result]);
    await queueWith(engine, [question, call, result, reply], "turn-1");
    await queueWith(engine, [question, call, result, reply], "turn-1-again");

    expect(stand.stored.map((message) => [message.role, message.source_message_ids])).toEqual([
      ["user", ["u1"]],
      ["assistant", ["r1"]],
      ["assistant", ["a1"]],
    ]);
  });

  it("после записи слив по X проверяется, как раньше", async () => {
    const stand = server();
    const { engine, diags } = engineOver(stand);

    await queueWith(engine, [question, reply], "turn-pour", { currentTokenCount: 1_000 });

    expect(diags.find((entry) => entry.stage === "pour_skip")?.data).toMatchObject({ reason: "below_x" });
  });

  it("без читателя шлюза -- прежняя запись и одно предупреждение", async () => {
    const stand = server();
    const { engine, warned } = engineOver(stand);
    const turns = [
      [question.message, reply.message],
      [{ role: "user", content: "а завтра?", timestamp: T0 + 60_000 }, { role: "assistant", content: [{ type: "text", text: "сухо" }], timestamp: T0 + 61_000 }],
    ];

    for (const [index, turn] of turns.entries()) {
      await engine.commitTurn?.({ advancementKey: `turn-old-${index}`, messages: turn as never, sessionId: SESSION, sessionKey: KEY } as never);
    }

    expect(stand.stored.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(warned.filter((line) => line.includes("readSessionTranscript"))).toHaveLength(1);
  });

  it("главная сборка дописывает ход, который Викинг не держит, и строит окно уже с ним", async () => {
    const stand = server();
    const { engine } = engineOver(stand);
    await queueWith(engine, [question, call, result, reply], "turn-written");
    const next = row("u2", { role: "user", content: "а завтра?", timestamp: T0 + 60_000 });
    const nextReply = row("a2", { role: "assistant", content: [{ type: "text", text: "сухо" }], timestamp: T0 + 61_000 });
    const branch = [question, call, result, reply, next, nextReply];
    const contextReads = () => stand.transport.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith("/context")).length;

    // The queue's write of the second turn failed; the next turn's assemble reads the fenced branch.
    const before = contextReads();
    const assembled = await engine.assemble({
      sessionId: SESSION,
      sessionKey: KEY,
      messages: branch.map((candidate) => candidate.message) as never,
      tokenBudget: 200_000,
      availableTools: new Set<string>(),
      runtimeContext: { sessionKey: KEY, readSessionTranscript: readerOver(branch) },
    } as never);

    expect(stand.stored.map((message) => message.source_message_ids)).toEqual([["u1"], ["r1"], ["a1"], ["u2"], ["a2"]]);
    expect(JSON.stringify(assembled.messages)).toContain("сухо");
    const afterFirst = contextReads();
    await engine.assemble({
      sessionId: SESSION,
      sessionKey: KEY,
      messages: branch.map((candidate) => candidate.message) as never,
      tokenBudget: 200_000,
      availableTools: new Set<string>(),
      runtimeContext: { sessionKey: KEY, readSessionTranscript: readerOver(branch) },
    } as never);
    // Caught up, the window is read again once; with nothing to write, not again.
    expect(afterFirst - before).toBeGreaterThan(contextReads() - afterFirst);
  });
});
