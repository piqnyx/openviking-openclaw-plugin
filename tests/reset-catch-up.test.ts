import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, type OVMessage, type OVMessagePart } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";
import { registerOpenVikingLifecycleHooks } from "../plugin/openviking-lifecycle-hooks.js";

/*
 * PLAN-krug Р1, шаг 7б: сброс беседы (/new, /reset). Читателя шлюза здесь нет -- в событии
 * `before_reset` сырые сообщения ветки, у каждого номер строки (`__openclaw.id`, перезаписанная --
 * с `originalEntryId`). Обычно писать нечего: последний ход записан в конце хода. Если запись
 * последнего хода сорвалась, а следом сброс, -- его строки дописываются (без отсева шлюза, с громкой
 * отметкой) и только потом сессия уходит в архив: иначе очередь допишет их в старую сессию уже после
 * архива, и они останутся без извлечения навсегда.
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

const message = (id: string, role: "user" | "assistant", text: string, originalEntryId?: string) => ({
  role,
  content: role === "user" ? text : [{ type: "text", text }],
  timestamp: Date.UTC(2026, 10, 9, 10, 0, 0),
  __openclaw: { id, ...(originalEntryId ? { originalEntryId } : {}) },
});

const held = (id: string, role: string, text: string): Stored => ({
  id: `ov-${id}`,
  role,
  parts: [{ type: "text", text }],
  created_at: "",
  source_message_ids: [id],
});

describe("сброс беседы", () => {
  it("дописывает строки, которых Викинг не держит, громко, и только потом архивирует", async () => {
    const stand = server([held("u1", "user", "привет"), held("a1", "assistant", "здравствуй")]);
    const { engine, warned } = engineOver(stand);
    const messages = [message("u1", "user", "привет"), message("a1", "assistant", "здравствуй"), message("u2", "user", "пока"), message("a2-again", "assistant", "до встречи", "a2")];

    const ok = await engine.commitOVSession({ sessionId: randomUUID(), sessionKey: "agent:main:main", transcriptMessages: messages } as never);

    expect(ok).toBe(true);
    expect(stand.events).toEqual(["write:u2", "write:a2", "commit"]);
    expect(warned.some((line) => line.includes("before_reset"))).toBe(true);
  });

  it("когда Викинг держит всё, ничего не пишет и не предупреждает", async () => {
    const stand = server([held("u1", "user", "привет"), held("a1", "assistant", "здравствуй")]);
    const { engine, warned } = engineOver(stand);

    await engine.commitOVSession({
      sessionId: randomUUID(),
      sessionKey: "agent:main:main",
      transcriptMessages: [message("u1", "user", "привет"), message("a1", "assistant", "здравствуй")],
    } as never);

    expect(stand.events).toEqual(["commit"]);
    expect(warned).toEqual([]);
  });

  it("крюк before_reset отдаёт движку сообщения события", async () => {
    const handlers = new Map<string, (event: unknown, ctx?: Record<string, unknown>) => unknown>();
    const commitOVSession = vi.fn(async () => true);
    registerOpenVikingLifecycleHooks({
      api: { on: (name, handler) => void handlers.set(name, handler as never) },
      rememberSessionAgentId: () => {},
      isBypassedSession: () => false,
      verboseRoutingInfo: () => {},
      getContextEngine: () => ({ commitOVSession }),
      logger: { info: () => {}, warn: () => {} },
    });
    const messages = [message("u1", "user", "привет")];

    await handlers.get("before_reset")?.({ messages, reason: "new" }, { sessionId: "s1", sessionKey: "agent:main:main" });

    expect(commitOVSession).toHaveBeenCalledWith({ sessionId: "s1", sessionKey: "agent:main:main", transcriptMessages: messages });
  });
});
