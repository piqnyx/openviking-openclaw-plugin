import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, type OVMessage, type OVMessagePart } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";
import { registerOpenVikingContextEngine } from "../plugin/openviking-context-engine-registration.js";
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

function server(options: { failWrites?: () => boolean; failContext?: () => boolean } = {}) {
  const stored: Stored[] = [];
  const commits: unknown[] = [];
  // As the server: a session never written to is unknown to reads; the first write creates it.
  let created = false;
  const transport: HttpTransport = vi.fn(async (url, init) => {
    const parsed = new URL(url);
    const answer = (body: unknown) =>
      new Response(JSON.stringify({ status: "ok", result: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const isWrite = (parsed.pathname.endsWith("/messages") || parsed.pathname.endsWith("/messages/batch")) && init?.method === "POST";
    if (isWrite && options.failWrites?.()) {
      return new Response(JSON.stringify({ status: "error", error: { code: "UNAVAILABLE", message: "storage busy" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (isWrite) {
      type Written = { role: string; parts: OVMessagePart[]; created_at?: string; source_message_ids?: string[] };
      const body = JSON.parse(String(init?.body)) as Written | { messages: Written[] };
      // As the server: the batch is one append, all of it (routers/sessions.py 541-590).
      const written = "messages" in body ? body.messages : [body];
      created = true;
      for (const message of written) {
        stored.push({
          id: `ov-${stored.length + 1}`,
          role: message.role,
          parts: message.parts,
          created_at: message.created_at ?? "",
          ...(message.source_message_ids ? { source_message_ids: message.source_message_ids } : {}),
        });
      }
      return answer({ session_id: SESSION });
    }
    if (!created && init?.method !== "POST") {
      return new Response(JSON.stringify({ status: "error", error: { code: "NOT_FOUND", message: "Session not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (parsed.pathname.endsWith("/context") && options.failContext?.()) {
      return new Response(JSON.stringify({ status: "error", error: { code: "INTERNAL", message: "storage busy" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
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

function engineOver(stand: ReturnType<typeof server>, overrides: Record<string, unknown> = {}) {
  const warned: string[] = [];
  const diags: Array<{ stage: string; data: Record<string, unknown> }> = [];
  const engine = createMemoryOpenVikingContextEngine({
    id: "openviking",
    name: "OpenViking",
    cfg: memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", autoRecall: false, emitStandardDiagnostics: true, ...overrides }),
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
/**
 * The gateway's reader over the branch as it stands now: the cursor names the last row read; under
 * a fence only rows before it are visible, and a cursor on the fence or past it is an error
 * (session-accessor.sqlite-active-events.ts 228-235).
 */
function readerOver(branch: BranchRow[], options: { fence?: number } = {}): SessionTranscriptReader {
  return {
    readVisiblePage: async (limits) => {
      const last = limits?.cursor !== undefined ? Number(limits.cursor) : -1;
      if (options.fence !== undefined && last >= options.fence) {
        throw Object.assign(new Error("Transcript read cursor has crossed the current-turn admission fence"), {
          name: "SessionTranscriptReadFenceError",
        });
      }
      const end = options.fence !== undefined ? Math.min(options.fence, branch.length) : branch.length;
      const rows = branch.slice(last + 1, end);
      return { kind: "page", cursor: String(last + rows.length), rows, hasMore: false };
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
    const { engine, warned, diags } = engineOver(stand);
    const turns = [
      [question.message, reply.message],
      [{ role: "user", content: "а завтра?", timestamp: T0 + 60_000 }, { role: "assistant", content: [{ type: "text", text: "сухо" }], timestamp: T0 + 61_000 }],
    ];

    for (const [index, turn] of turns.entries()) {
      await engine.commitTurn?.({ advancementKey: `turn-old-${index}`, messages: turn as never, sessionId: SESSION, sessionKey: KEY } as never);
    }

    expect(stand.stored.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(warned.filter((line) => line.includes("readSessionTranscript"))).toHaveLength(1);
    // The old way keeps its journal (inventory З7).
    expect(diags.filter((entry) => entry.stage === "afterTurn_entry")).toHaveLength(2);
  });

  // Проверяющий плагина (10.11): сессию, которую Викинг уже держит по номерам строк, ведёт «догнать»; ход без
  // читателя (редкий путь нового шлюза) по-старому не пишется -- иначе следующее «догнать» записало бы его снова.
  it("без читателя, а сессию уже ведёт «догнать», -- ход по-старому не пишется, его пишет «догнать» один раз", async () => {
    const stand = server();
    const { engine, diags } = engineOver(stand);
    await queueWith(engine, [question, reply], "turn-written");
    const next = row("u2", { role: "user", content: "а завтра?", timestamp: T0 + 60_000 });
    const nextReply = row("a2", { role: "assistant", content: [{ type: "text", text: "сухо" }], timestamp: T0 + 61_000 });

    await engine.commitTurn?.({
      advancementKey: "turn-no-reader",
      messages: [next.message, nextReply.message] as never,
      sessionId: SESSION,
      sessionKey: KEY,
    } as never);
    expect(diags.find((entry) => entry.stage === "afterTurn_skip")?.data).toMatchObject({ reason: "catch_up_owns_session" });
    await queueWith(engine, [question, reply, next, nextReply], "turn-after");

    expect(stand.stored.map((message) => message.source_message_ids)).toEqual([["u1"], ["a1"], ["u2"], ["a2"]]);
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
    // The window, and once more after the catch-up wrote; with nothing to write, only the window.
    expect([afterFirst - before, contextReads() - afterFirst]).toEqual([2, 1]);
  });

  it("повторная сборка после записи посреди своего хода не падает на ограде шлюза", async () => {
    const stand = server();
    const { engine, diags } = engineOver(stand);
    const earlier = row("u0", { role: "user", content: "привет", timestamp: T0 - 60_000 });
    const earlierReply = row("a0", { role: "assistant", content: [{ type: "text", text: "здравствуй" }], timestamp: T0 - 59_000 });
    await queueWith(engine, [earlier, earlierReply], "turn-earlier");
    const branch = [earlier, earlierReply, question, call, result];
    const assemble = async () =>
      await engine.assemble({
        sessionId: SESSION,
        sessionKey: KEY,
        messages: branch.map((candidate) => candidate.message) as never,
        tokenBudget: 200_000,
        availableTools: new Set<string>(),
        // The current question is row 2: the fence of this turn.
        runtimeContext: { sessionKey: KEY, readSessionTranscript: readerOver(branch, { fence: 2 }) },
      } as never);

    await assemble();
    await hookWith(engine, branch);
    // The model failed; the retry builds the window again under the same fence.
    await assemble();

    expect(diags.filter((entry) => entry.stage === "assemble_error")).toEqual([]);
  });

  it("сборка: «догнать» не дописало -- окно этого хода запасным путём, громко", async () => {
    let down = false;
    const stand = server({ failWrites: () => down });
    const { engine, diags, warned } = engineOver(stand);
    await queueWith(engine, [question, reply], "turn-written");
    const next = row("u2", { role: "user", content: "а завтра?", timestamp: T0 + 60_000 });
    const nextReply = row("a2", { role: "assistant", content: [{ type: "text", text: "сухо" }], timestamp: T0 + 61_000 });
    const branch = [question, reply, next, nextReply];
    down = true;

    await engine.assemble({
      sessionId: SESSION,
      sessionKey: KEY,
      messages: branch.map((candidate) => candidate.message) as never,
      tokenBudget: 200_000,
      availableTools: new Set<string>(),
      runtimeContext: { sessionKey: KEY, readSessionTranscript: readerOver(branch) },
    } as never);

    expect(diags.find((entry) => entry.stage === "assemble_result")?.data).toMatchObject({ reason: "catch_up_stopped" });
    expect(warned.some((line) => line.includes("catch-up did not complete"))).toBe(true);
  });

  // PLAN-krug 7в.7г (НД-3): the rows are written and the answer in hand is from before them; a passing error
  // of the read after the write sends the window by the live transcript, as when the catch-up did not complete.
  it("сборка: «догнать» дописало, а перечитать ответ не вышло -- запасной путь, не сбой сборки", async () => {
    let reads = -1;
    const stand = server({ failContext: () => reads >= 0 && ++reads === 2 });
    const { engine, diags, warned } = engineOver(stand);
    await queueWith(engine, [question, reply], "turn-written");
    const next = row("u2", { role: "user", content: "а завтра?", timestamp: T0 + 60_000 });
    const nextReply = row("a2", { role: "assistant", content: [{ type: "text", text: "сухо" }], timestamp: T0 + 61_000 });
    const branch = [question, reply, next, nextReply];
    reads = 0;

    const assembled = await engine.assemble({
      sessionId: SESSION,
      sessionKey: KEY,
      messages: branch.map((candidate) => candidate.message) as never,
      tokenBudget: 200_000,
      availableTools: new Set<string>(),
      runtimeContext: { sessionKey: KEY, readSessionTranscript: readerOver(branch) },
    } as never);

    expect(stand.stored.map((message) => message.source_message_ids)).toEqual([["u1"], ["a1"], ["u2"], ["a2"]]);
    expect(diags.filter((entry) => entry.stage === "assemble_error")).toEqual([]);
    expect(diags.find((entry) => entry.stage === "assemble_result")?.data).toMatchObject({
      reason: "catch_up_reread_failed",
    });
    expect(JSON.stringify(assembled.messages)).toContain("сухо");
    expect(warned.some((line) => line.includes("could not be read again"))).toBe(true);
  });

  it("сбой «догнать» в конце хода слив по X не отменяет", async () => {
    const stand = server();
    const { engine, diags } = engineOver(stand);
    const broken: SessionTranscriptReader = {
      readVisiblePage: async () => {
        throw new Error("projection broke");
      },
      selectModelVisible: (rows) => rows,
    };

    await engine.commitTurn?.({
      advancementKey: "turn-broken",
      messages: [question.message, reply.message] as never,
      sessionId: SESSION,
      sessionKey: KEY,
      runtimeContext: { readSessionTranscript: broken, currentTokenCount: 1_000 },
    } as never);

    expect(diags.find((entry) => entry.stage === "pour_skip")?.data).toMatchObject({ reason: "below_x" });
  });

  // PLAN-krug П3': the gateway keeps a broken turn's question on the branch (telegram and web write it
  // before the run: agent-runner-execute.ts admitUserTurn; attempt-session-prepare.ts then leaves it),
  // and the model sees it next to the next question -- so only the turn still running holds it back.
  const u0 = row("u0", { role: "user", content: "привет", timestamp: T0 - 60_000 });
  const a0 = row("a0", { role: "assistant", content: [{ type: "text", text: "здравствуй" }], timestamp: T0 - 59_000 });

  it("сборка после перезапуска сверяется с остатком, который уже прочитала: /context -- окно и после записи (В9, К12)", async () => {
    const stand = server();
    // Viking holds the first row; this process knows nothing of the session (a restart).
    await stand.client.addSessionMessage(SESSION, "user", [{ type: "text", text: "привет" }], undefined, undefined, undefined, ["u0"]);
    const { engine } = engineOver(stand);
    const branch = [u0, a0, question];
    const contextReads = () => stand.transport.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith("/context")).length;

    const before = contextReads();
    await engine.assemble({
      sessionId: SESSION,
      sessionKey: KEY,
      messages: branch.map((candidate) => candidate.message) as never,
      tokenBudget: 200_000,
      availableTools: new Set<string>(),
      runtimeContext: { sessionKey: KEY, readSessionTranscript: readerOver(branch, { fence: 2 }) },
    } as never);

    expect(stand.stored.map((message) => message.source_message_ids)).toEqual([["u0"], ["a0"]]);
    expect(contextReads() - before).toBe(2);
  });

  // PLAN-krug 7в.2: Viking keeps a tool round as one message, the gateway as several -- after the catch-up
  // that is no reason to cut the window to K.
  it("диалог без архивов с кругом инструментов после «догнать» -- окно из Викинга, не запасной путь", async () => {
    const stand = server();
    const { engine, diags } = engineOver(stand);
    await queueWith(engine, [question, call, result, reply], "turn-tools");
    const next = row("u2", { role: "user", content: "а завтра?", timestamp: T0 + 60_000 });
    const branch = [question, call, result, reply, next];

    await engine.assemble({
      sessionId: SESSION,
      sessionKey: KEY,
      messages: [question, call, result, reply].map((candidate) => candidate.message) as never,
      tokenBudget: 200_000,
      availableTools: new Set<string>(),
      runtimeContext: { sessionKey: KEY, readSessionTranscript: readerOver(branch, { fence: 4 }) },
    } as never);

    const outcome = diags.filter((entry) => entry.stage === "assemble_result").at(-1)?.data;
    expect(outcome).toMatchObject({ passthrough: false });
    expect(outcome?.reason).toBeUndefined();
  });

  it("сорванный ход: его вопрос без ответа пишется на сборке следующего хода -- модель его видит", async () => {
    const stand = server();
    const { engine } = engineOver(stand);
    await queueWith(engine, [u0, a0], "turn-earlier");
    const broken = row("q1", { role: "user", content: "а погода?", timestamp: T0 });
    const next = row("q2", { role: "user", content: "ты тут?", timestamp: T0 + 60_000 });
    const branch = [u0, a0, broken, next];

    await engine.assemble({
      sessionId: SESSION,
      sessionKey: KEY,
      messages: branch.map((candidate) => candidate.message) as never,
      tokenBudget: 200_000,
      availableTools: new Set<string>(),
      runtimeContext: { sessionKey: KEY, readSessionTranscript: readerOver(branch, { fence: 3 }) },
    } as never);

    expect(stand.stored.map((message) => message.source_message_ids)).toEqual([["u0"], ["a0"], ["q1"]]);
  });

  it("посреди хода вопрос без продолжения ждёт: его ход ещё идёт", async () => {
    const stand = server();
    const { engine } = engineOver(stand);
    await queueWith(engine, [u0, a0], "turn-earlier");

    await hookWith(engine, [u0, a0, question]);

    expect(stand.stored.map((message) => message.source_message_ids)).toEqual([["u0"], ["a0"]]);
  });

  // PLAN-krug 7в.4 (Н2): the queue does not write a lone question at the branch's end either -- at the start
  // of a turn and in the background that question may be the new turn's own, which comes as the prompt.
  it("ход кончился без видимого ответа -- вопрос ждёт и пишется на сборке следующего хода", async () => {
    const stand = server();
    const { engine } = engineOver(stand);
    await queueWith(engine, [u0, a0], "turn-earlier");

    // The reply was a silent one (NO_REPLY): the gateway's rule of what the model sees drops it.
    await queueWith(engine, [u0, a0, question], "turn-silent");
    const afterQueue = stand.stored.map((message) => message.source_message_ids);
    const next = row("u2", { role: "user", content: "а завтра?", timestamp: T0 + 60_000 });
    const branch = [u0, a0, question, next];
    await engine.assemble({
      sessionId: SESSION,
      sessionKey: KEY,
      messages: [u0, a0, question].map((candidate) => candidate.message) as never,
      tokenBudget: 200_000,
      availableTools: new Set<string>(),
      runtimeContext: { sessionKey: KEY, readSessionTranscript: readerOver(branch, { fence: 3 }) },
    } as never);

    expect(afterQueue).toEqual([["u0"], ["a0"]]);
    expect(stand.stored.map((message) => message.source_message_ids)).toEqual([["u0"], ["a0"], ["u1"]]);
  });

  it("вопрос нового хода не пишется записью из очереди и не задваивается в окне (Н2)", async () => {
    const stand = server();
    const { engine } = engineOver(stand);
    await queueWith(engine, [u0, a0], "turn-earlier");

    // The previous turn's record drained at the start of the next one: its open read meets the new question.
    await queueWith(engine, [u0, a0, question], "turn-earlier-drained-late");
    const assembled = await engine.assemble({
      sessionId: SESSION,
      sessionKey: KEY,
      // As the gateway hands it: the admitted question is taken off and comes as the prompt.
      messages: [u0, a0].map((candidate) => candidate.message) as never,
      tokenBudget: 200_000,
      availableTools: new Set<string>(),
      runtimeContext: { sessionKey: KEY, readSessionTranscript: readerOver([u0, a0, question], { fence: 2 }) },
    } as never);

    expect(stand.stored.map((message) => message.source_message_ids)).toEqual([["u0"], ["a0"]]);
    expect(JSON.stringify(assembled.messages)).not.toContain("погода?");
  });

  it("журнал afterTurn_entry (опись З7) пишется и на пути с читателем", async () => {
    const stand = server();
    const { engine, diags } = engineOver(stand);

    await queueWith(engine, [question, reply], "turn-journal", { currentTokenCount: 1_000, tokenBudget: 249_000 });

    expect(diags.find((entry) => entry.stage === "afterTurn_entry")?.data).toMatchObject({
      window: 1_000,
      hostTokenBudget: 249_000,
    });
  });

  it("autoCapture: false -- сборка и сброс в Викинг ничего не пишут", async () => {
    const stand = server();
    // The session exists in Viking, with the earlier turn written by hand.
    await stand.client.addSessionMessage(SESSION, "user", [{ type: "text", text: "привет" }], undefined, undefined, undefined, ["u0"]);
    const { engine } = engineOver(stand, { autoCapture: false });
    const branch = [u0, a0, question, reply];

    await engine.assemble({
      sessionId: SESSION,
      sessionKey: KEY,
      messages: branch.map((candidate) => candidate.message) as never,
      tokenBudget: 200_000,
      availableTools: new Set<string>(),
      runtimeContext: { sessionKey: KEY, readSessionTranscript: readerOver(branch) },
    } as never);
    await engine.commitOVSession({ sessionId: SESSION, sessionKey: KEY, transcriptReader: readerOver(branch) } as never);

    expect(stand.stored.map((message) => message.source_message_ids)).toEqual([["u0"]]);
  });

  it("Викинг объявляет шлюзу, что догоняет пропущенные ходы по переписке (договор 5в.1)", () => {
    const { engine } = engineOver(server());

    // With it the gateway drops a queued turn it can no longer read instead of keeping it as a plug.
    expect(engine.info.transcriptSemantics).toMatchObject({ turnAdvancementRecovery: "transcript-catch-up-v1" });
  });
});

/*
 * PLAN-krug К18: the gateway builds a fresh engine for each logical turn (`resolveLogicalTurnContextEngines`
 * calls the plugin's factory every time) -- the «догнать» memory must outlive the engine, or each turn reads
 * the gateway's branch from its start again.
 */
describe("память «догнать» между ходами: движок у шлюза новый на каждый ход", () => {
  beforeEach(() => {
    SESSION = randomUUID();
  });

  it("следующий ход читает ветку с места, где остановился прошлый, а не с начала", async () => {
    const stand = server();
    let factory: (() => unknown) | undefined;
    registerOpenVikingContextEngine({
      api: { registerContextEngine: (_id, registered) => void (factory = registered) },
      plugin: { id: "openviking", name: "OpenViking" },
      version: "test",
      cfg: memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", autoRecall: false }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      getClient: async () => stand.client,
      resolveAgentId: () => "main",
      rememberSessionAgentId: () => {},
      queryConfigStore: undefined,
      traceRecorder: undefined,
      createContextEngine: createMemoryOpenVikingContextEngine,
      setContextEngineRef: () => {},
    });
    const engineOfTurn = () => factory?.() as ReturnType<typeof createMemoryOpenVikingContextEngine>;
    const servedRows = (branch: BranchRow[], options: { fence?: number } = {}) => {
      const served: string[] = [];
      const reader = readerOver(branch, options);
      const recording: SessionTranscriptReader = {
        ...reader,
        readVisiblePage: async (limits) => {
          const page = await reader.readVisiblePage(limits);
          if (page.kind === "page") {
            served.push(...page.rows.map((candidate) => candidate.entryId));
          }
          return page;
        },
      };
      return { served, reader: recording };
    };
    const assembleTurn = async (engine: ReturnType<typeof engineOfTurn>, branch: BranchRow[], reader: SessionTranscriptReader) =>
      await engine.assemble({
        sessionId: SESSION,
        sessionKey: KEY,
        messages: branch.map((candidate) => candidate.message) as never,
        tokenBudget: 200_000,
        availableTools: new Set<string>(),
        runtimeContext: { sessionKey: KEY, readSessionTranscript: reader },
      } as never);
    const greeting = row("u0", { role: "user", content: "привет", timestamp: T0 - 60_000 });
    const greetingReply = row("a0", { role: "assistant", content: [{ type: "text", text: "здравствуй" }], timestamp: T0 - 59_000 });
    const next = row("u2", { role: "user", content: "а завтра?", timestamp: T0 + 60_000 });

    // A dialog Viking already holds (a brand-new session has no window to catch up against).
    await queueWith(engineOfTurn(), [greeting, greetingReply], "turn-earlier");
    const first = engineOfTurn();
    await assembleTurn(first, [greeting, greetingReply, question], servedRows([greeting, greetingReply, question], { fence: 2 }).reader);
    await queueWith(first, [greeting, greetingReply, question, reply], "turn-first");
    const second = engineOfTurn();
    const secondRead = servedRows([greeting, greetingReply, question, reply, next], { fence: 4 });
    await assembleTurn(second, [greeting, greetingReply, question, reply, next], secondRead.reader);

    expect(second).not.toBe(first);
    expect(stand.stored.map((message) => message.source_message_ids)).toEqual([["u0"], ["a0"], ["u1"], ["a1"]]);
    expect(secondRead.served).toEqual(["u1", "a1"]);
  });
});
