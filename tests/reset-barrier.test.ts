import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, type OVMessage, type OVMessagePart } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";
import { registerOpenVikingContextEngine } from "../plugin/openviking-context-engine-registration.js";
import { registerOpenVikingLifecycleHooks } from "../plugin/openviking-lifecycle-hooks.js";
import type { SessionTranscriptReader } from "../services/branch-reader.js";
import type { BranchRow } from "../services/transcript-catch-up.js";

/*
 * PLAN-krug К20 (Вит 09.11: «чини сейчас, первый вариант»): a reset keeps the session id, so the old
 * and the new conversation share one Viking session; the gateway fires before_reset and goes on with
 * the new conversation at once. The new conversation's first steps wait until the server has archived
 * the old one (phase 1) -- not for the memory extraction after it (phase 2).
 */

const KEY = "agent:main:telegram:direct:1";
const T0 = Date.UTC(2026, 10, 9, 10, 0, 0);

type Stored = OVMessage & { source_message_ids?: string[] };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * As the server (openviking/session/session.py 3304-3333; routers/sessions.py 440): writes go live; a
 * commit archives the live messages at once (phase 1); until the archive's summary stands (phase 2) the
 * context gives the archive's messages raw, with the live ones, and counts the archive unsummarized.
 * The summary stands once the plugin's hold asks about the session, or when the test says so.
 */
function server(options: { commitGate?: Promise<void>; commitFails?: boolean; summaryOnAsk?: boolean } = {}) {
  const live: Stored[] = [];
  const events: string[] = [];
  let pending: Stored[] | null = null;
  let summarized = 0;
  const finishSummary = () => {
    if (pending) {
      pending = null;
      summarized += 1;
      events.push("summary");
    }
  };
  const answer = (body: unknown) =>
    new Response(JSON.stringify({ status: "ok", result: body }), { status: 200, headers: { "Content-Type": "application/json" } });
  const transport: HttpTransport = vi.fn(async (url, init) => {
    const parsed = new URL(url);
    if ((parsed.pathname.endsWith("/messages") || parsed.pathname.endsWith("/messages/batch")) && init?.method === "POST") {
      type Written = { role: string; parts: OVMessagePart[]; source_message_ids?: string[] };
      const body = JSON.parse(String(init.body)) as Written | { messages: Written[] };
      for (const message of "messages" in body ? body.messages : [body]) {
        live.push({ id: `ov-${live.length + 1}`, role: message.role, parts: message.parts, created_at: "", ...(message.source_message_ids ? { source_message_ids: message.source_message_ids } : {}) });
        events.push(`write:${(message.source_message_ids ?? []).join(",")}`);
      }
      return answer({ session_id: "s" });
    }
    if (parsed.pathname.endsWith("/commit")) {
      await options.commitGate;
      if (options.commitFails) {
        events.push("commit-failed");
        return new Response(JSON.stringify({ status: "error", error: { code: "UNAVAILABLE", message: "busy" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      pending = [...live];
      live.length = 0;
      events.push("commit");
      return answer({ session_id: "s", status: "accepted", archived: true, task_id: "task-1" });
    }
    if (parsed.pathname.includes("/tasks/")) {
      return answer({ task_id: "task-1", status: pending ? "running" : "completed", result: {} });
    }
    if (parsed.pathname.endsWith("/context")) {
      events.push("context");
      return answer({
        latest_archive_overview: summarized > 0 ? "сводка старой беседы" : "",
        pre_archive_abstracts: [],
        messages: [...(pending ?? []), ...live],
        estimatedTokens: 1,
        stats: {
          totalArchives: summarized + (pending ? 1 : 0),
          includedArchives: summarized,
          droppedArchives: 0,
          failedArchives: 0,
          activeTokens: 1,
          archiveTokens: 0,
          unsummarizedArchives: pending ? 1 : 0,
        },
      });
    }
    // A question about the session (the plugin's hold for the summary asks here).
    if (options.summaryOnAsk !== false) {
      finishSummary();
    }
    return answer({ pending_tokens: 0, unsummarized_archives: pending ? 1 : 0 });
  });
  const client = new OpenVikingClient("http://127.0.0.1:1933", "ov-key", "main", 5_000, "", "", undefined, {
    transport,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  return { client, live, events, finishSummary };
}

function row(id: string, role: "user" | "assistant", text: string, at: number): BranchRow {
  return { entryId: id, firstEntryId: id, message: { role, content: role === "user" ? text : [{ type: "text", text }], timestamp: at } };
}

function readerOver(branch: BranchRow[], options: { fence?: number } = {}): SessionTranscriptReader {
  return {
    readVisiblePage: async (limits) => {
      const last = limits?.cursor !== undefined ? Number(limits.cursor) : -1;
      const end = options.fence !== undefined ? Math.min(options.fence, branch.length) : branch.length;
      const rows = branch.slice(last + 1, end);
      return { kind: "page", cursor: String(last + rows.length), rows, hasMore: false };
    },
    selectModelVisible: (rows) => rows,
  };
}

/** The plugin as the gateway runs it: one registration, an engine per logical turn, the lifecycle hooks. */
function pluginOver(stand: ReturnType<typeof server>, settings: Record<string, unknown> = {}) {
  let factory: (() => unknown) | undefined;
  let latest: ReturnType<typeof createMemoryOpenVikingContextEngine> | undefined;
  registerOpenVikingContextEngine({
    api: { registerContextEngine: (_id, registered) => void (factory = registered) },
    plugin: { id: "openviking", name: "OpenViking" },
    version: "test",
    cfg: memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", autoRecall: false, ...settings }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    getClient: async () => stand.client,
    resolveAgentId: () => "main",
    rememberSessionAgentId: () => {},
    queryConfigStore: undefined,
    traceRecorder: undefined,
    createContextEngine: createMemoryOpenVikingContextEngine,
    setContextEngineRef: (engine) => void (latest = engine),
  });
  const handlers = new Map<string, (event: unknown, ctx?: Record<string, unknown>) => unknown>();
  registerOpenVikingLifecycleHooks({
    api: { on: (name, handler) => void handlers.set(name, handler as never) },
    rememberSessionAgentId: () => {},
    isBypassedSession: () => false,
    verboseRoutingInfo: () => {},
    getContextEngine: () => latest ?? null,
    logger: { info: () => {}, warn: () => {} },
  });
  const engineOfTurn = () => factory?.() as ReturnType<typeof createMemoryOpenVikingContextEngine>;
  // As the gateway: the hook is fired and not waited for (session-reset-service.ts, commands-reset-hooks.ts).
  const fireReset = (sessionId: string, branch: BranchRow[]) =>
    Promise.resolve(
      handlers.get("before_reset")?.(
        {
          reason: "new",
          messages: branch.map((candidate) => ({ ...(candidate.message as Record<string, unknown>), __openclaw: { id: candidate.entryId } })),
          selectModelVisible: <T extends { message: unknown }>(rows: T[]) => rows,
        },
        { sessionId, sessionKey: KEY },
      ),
    );
  return { engineOfTurn, fireReset };
}

const old = [row("u0", "user", "старая беседа", T0), row("a0", "assistant", "старый ответ", T0 + 1_000)];
const asked = row("u1", "user", "новая беседа", T0 + 60_000);
const answered = row("a1", "assistant", "новый ответ", T0 + 61_000);

async function assembleTurn(engine: ReturnType<typeof createMemoryOpenVikingContextEngine>, sessionId: string, branch: BranchRow[], fence: number) {
  return await engine.assemble({
    sessionId,
    sessionKey: KEY,
    messages: [asked.message] as never,
    tokenBudget: 200_000,
    availableTools: new Set<string>(),
    runtimeContext: { sessionKey: KEY, readSessionTranscript: readerOver(branch, { fence }) },
  } as never);
}

/** The old conversation's turn, written by its own engine -- the engine the reset hook later reaches. */
async function oldConversation(plugin: ReturnType<typeof pluginOver>, sessionId: string) {
  await plugin.engineOfTurn().commitTurn?.({
    advancementKey: `turn-old-${sessionId}`,
    messages: old.map((candidate) => candidate.message) as never,
    sessionId,
    sessionKey: KEY,
    runtimeContext: { readSessionTranscript: readerOver(old) },
  } as never);
}

/** Settles in time, or says it did not. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> {
  return await Promise.race([promise, new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), ms))]);
}

describe("сброс: первые шаги новой беседы ждут архива старой (PLAN-krug К20)", () => {
  // Вит 09.11 (Н-ж): the first turn after /new waits for the old conversation's summary -- the hold the pour has.
  it("окно и первая запись новой беседы -- после архива старой; в окне сводка старой беседы, не она сама", async () => {
    const gate = deferred();
    const stand = server({ commitGate: gate.promise });
    const sessionId = randomUUID();
    const plugin = pluginOver(stand);
    await oldConversation(plugin, sessionId);

    const resetting = plugin.fireReset(sessionId, old);
    const branch = [...old, asked, answered];
    const engine = plugin.engineOfTurn();
    const assembling = assembleTurn(engine, sessionId, branch, 2);
    const writing = engine.afterTurn?.({
      sessionId,
      sessionFile: "/tmp/s.jsonl",
      messages: branch.map((candidate) => candidate.message) as never,
      prePromptMessageCount: 2,
      runtimeContext: { sessionKey: KEY, senderId: "1", readSessionTranscript: readerOver(branch) },
    } as never);
    setTimeout(() => gate.release(), 20);
    const assembled = await assembling;
    await writing;
    // The server writes the summary on its own; the reset waits for it (phase 2) and is done then.
    await vi.waitFor(() => expect(stand.events).toContain("commit"));
    stand.finishSummary();
    await resetting;

    expect(stand.events.indexOf("commit")).toBeGreaterThan(-1);
    expect(stand.events.indexOf("commit")).toBeLessThan(stand.events.indexOf("write:u1"));
    expect(JSON.stringify(assembled.messages)).not.toContain("старая беседа");
    expect(JSON.stringify(assembled.messages)).toContain("сводка старой беседы");
  });

  it("конец первого хода через очередь (телега, веб) пишется после архива старой беседы", async () => {
    const gate = deferred();
    const stand = server({ commitGate: gate.promise });
    const sessionId = randomUUID();
    const plugin = pluginOver(stand);
    await oldConversation(plugin, sessionId);

    const resetting = plugin.fireReset(sessionId, old);
    const branch = [...old, asked, answered];
    const committing = plugin.engineOfTurn().commitTurn?.({
      advancementKey: `turn-new-${sessionId}`,
      messages: branch.map((candidate) => candidate.message) as never,
      sessionId,
      sessionKey: KEY,
      runtimeContext: { readSessionTranscript: readerOver(branch) },
    } as never);
    setTimeout(() => gate.release(), 20);
    await committing;
    // The server writes the summary on its own; the reset waits for it (phase 2) and is done then.
    await vi.waitFor(() => expect(stand.events).toContain("commit"));
    stand.finishSummary();
    await resetting;

    expect(stand.events.indexOf("commit")).toBeGreaterThan(-1);
    expect(stand.events.indexOf("commit")).toBeLessThan(stand.events.indexOf("write:u1"));
  });

  it("барьер снят, как только сервер принял архив, -- не держит ход до конца второй фазы", async () => {
    const stand = server({ summaryOnAsk: false });
    const sessionId = randomUUID();
    // The hold for the summary off: what is measured is the barrier alone.
    const plugin = pluginOver(stand, { holdForSummarySeconds: 0 });
    await oldConversation(plugin, sessionId);

    const resetting = plugin.fireReset(sessionId, old);
    const assembled = await within(assembleTurn(plugin.engineOfTurn(), sessionId, [...old, asked], 2), 2_000);
    stand.finishSummary();
    await resetting;

    expect(stand.events).toContain("commit");
    expect(assembled).not.toBe("timed out");
  });

  it("архив не удался -- барьер всё равно снят", async () => {
    const stand = server({ commitFails: true });
    const sessionId = randomUUID();
    const plugin = pluginOver(stand);
    await oldConversation(plugin, sessionId);

    const resetting = plugin.fireReset(sessionId, old);
    const assembled = await within(assembleTurn(plugin.engineOfTurn(), sessionId, [...old, asked], 2), 2_000);
    await resetting;

    expect(stand.events).toContain("commit-failed");
    expect(assembled).not.toBe("timed out");
  });
});
