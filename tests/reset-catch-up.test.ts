import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, type OVMessage, type OVMessagePart } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";
import { registerOpenVikingLifecycleHooks } from "../plugin/openviking-lifecycle-hooks.js";
import type { SessionTranscriptReader } from "../services/branch-reader.js";
import type { BranchRow } from "../services/transcript-catch-up.js";

/*
 * PLAN-krug Р1, шаг 7б, К13 (П13'): сброс беседы (/new, /reset). Шлюз кладёт в событие `before_reset`
 * читателя сбрасываемой сессии (`readSessionTranscript`). Обычно писать нечего: последний ход записан в
 * конце хода. Если запись последнего хода сорвалась, а следом сброс, -- его строки дописываются (по
 * отбору шлюза «как видит модель», номера -- у сервера, громко) и только потом сессия уходит в архив:
 * иначе очередь допишет их в старую сессию уже после архива. Шлюз старее (в событии только сообщения) --
 * только архив, как было до 7б.
 */

type Stored = OVMessage & { source_message_ids?: string[] };

function server(stored: Stored[] = []) {
  const events: string[] = [];
  const transport: HttpTransport = vi.fn(async (url, init) => {
    const parsed = new URL(url);
    const answer = (body: unknown) =>
      new Response(JSON.stringify({ status: "ok", result: body }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (parsed.pathname.endsWith("/messages") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { role: string; parts: OVMessagePart[]; source_message_ids?: string[] };
      stored.push({ id: `ov-${stored.length + 1}`, role: body.role, parts: body.parts, created_at: "", ...(body.source_message_ids ? { source_message_ids: body.source_message_ids } : {}) });
      events.push(`write:${(body.source_message_ids ?? []).join(",")}`);
      return answer({ session_id: "s" });
    }
    if (parsed.pathname.endsWith("/context")) {
      return answer({
        latest_archive_overview: "",
        pre_archive_abstracts: [],
        messages: stored,
        estimatedTokens: 1,
        stats: { totalArchives: 0, includedArchives: 0, droppedArchives: 0, failedArchives: 0, activeTokens: 1, archiveTokens: 0 },
      });
    }
    if (parsed.pathname.endsWith("/commit")) {
      events.push("commit");
      return answer({ status: "accepted", archived: true });
    }
    return answer({ status: "completed" });
  });
  const client = new OpenVikingClient("http://127.0.0.1:1933", "ov-key", "main", 5_000, "", "", undefined, { transport });
  return { client, stored, events };
}

function engineOver(stand: ReturnType<typeof server>) {
  const warned: string[] = [];
  const engine = createMemoryOpenVikingContextEngine({
    id: "openviking",
    name: "OpenViking",
    cfg: memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", autoRecall: false }),
    logger: { info: () => {}, warn: (line) => warned.push(line), error: () => {} },
    getClient: async () => stand.client,
    resolveAgentId: () => "main",
  });
  return { engine, warned };
}

const T0 = Date.UTC(2026, 10, 9, 10, 0, 0);

function row(id: string, role: "user" | "assistant", text: string, firstEntryId = id): BranchRow {
  return {
    entryId: id,
    firstEntryId,
    message: { role, content: role === "user" ? text : [{ type: "text", text }], timestamp: T0 },
  };
}

/** The gateway's read of the reset session; its model view drops the rows marked as delivery copies. */
function readerOver(branch: BranchRow[]): SessionTranscriptReader {
  return {
    readVisiblePage: async () => ({ kind: "page", cursor: String(branch.length - 1), rows: branch, hasMore: false }),
    selectModelVisible: (rows) => rows.filter((candidate) => !candidate.entryId.startsWith("copy")),
  };
}

/** The plugin's hooks over a real engine, as the gateway fires them. */
function hooksOver(engine: ReturnType<typeof engineOver>["engine"]) {
  const handlers = new Map<string, (event: unknown, ctx?: Record<string, unknown>) => unknown>();
  registerOpenVikingLifecycleHooks({
    api: { on: (name, handler) => void handlers.set(name, handler as never) },
    rememberSessionAgentId: () => {},
    isBypassedSession: () => false,
    verboseRoutingInfo: () => {},
    getContextEngine: () => engine,
    logger: { info: () => {}, warn: () => {} },
  });
  return async (event: Record<string, unknown>) =>
    await handlers.get("before_reset")?.(event, { sessionId: randomUUID(), sessionKey: "agent:main:main" });
}

const held = (id: string, role: string, text: string): Stored => ({
  id: `ov-${id}`,
  role,
  parts: [{ type: "text", text }],
  created_at: "",
  source_message_ids: [id],
});

describe("сброс беседы", () => {
  it("дописывает строки, которых Викинг не держит, по отбору шлюза, громко, и только потом архивирует", async () => {
    const stand = server([held("u1", "user", "привет"), held("a1", "assistant", "здравствуй")]);
    const { engine, warned } = engineOver(stand);
    const branch = [
      row("u1", "user", "привет"),
      row("a1", "assistant", "здравствуй"),
      row("u2", "user", "пока"),
      row("copy-1", "assistant", "до встречи"),
      row("a2-again", "assistant", "до встречи", "a2"),
    ];

    await hooksOver(engine)({ messages: [], reason: "new", readSessionTranscript: readerOver(branch) });

    expect(stand.events).toEqual(["write:u2", "write:a2", "commit"]);
    expect(warned.some((line) => line.includes("before_reset"))).toBe(true);
  });

  it("когда Викинг держит всё, ничего не пишет и не предупреждает", async () => {
    const stand = server([held("u1", "user", "привет"), held("a1", "assistant", "здравствуй")]);
    const { engine, warned } = engineOver(stand);

    await hooksOver(engine)({
      messages: [],
      reason: "new",
      readSessionTranscript: readerOver([row("u1", "user", "привет"), row("a1", "assistant", "здравствуй")]),
    });

    expect(stand.events).toEqual(["commit"]);
    expect(warned).toEqual([]);
  });

  it("шлюз старее: в событии только сообщения -- только архив, ничего не пишется", async () => {
    const stand = server([held("u1", "user", "привет")]);
    const { engine } = engineOver(stand);
    const messages = [
      { role: "user", content: "привет", timestamp: T0, __openclaw: { id: "u1" } },
      { role: "assistant", content: [{ type: "text", text: "здравствуй" }], timestamp: T0, __openclaw: { id: "a1" } },
    ];

    await hooksOver(engine)({ messages, reason: "new" });

    expect(stand.events).toEqual(["commit"]);
  });
});
