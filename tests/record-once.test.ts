import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, type OVMessage, type OVMessagePart } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";

/*
 * Ход записывается в Викинг один раз (PLAN-gorizont, 5-0; разбор 07.10 по живым данным).
 *
 * На этом шлюзе плагин зовут двумя путями. Хук перед КАЖДЫМ обращением к модели отдаёт новые
 * сообщения транскрипта: в первый раз служебное сообщение шлюза и вопрос, дальше результаты
 * инструментов; ответ модели хук не видит никогда. В конце хода очередь шлюза отдаёт закрытый ход
 * целиком: вопрос, вызовы и результаты инструментов, ответ -- без контекста хода и без границы.
 * Отпечатки обоих путей различны, и на сервере вопрос оказывался дважды, а служебное сообщение
 * шлюза -- как сообщение пользователя (данные сервера 06--07.10: четыре записи на ход).
 *
 * Правило: хук пишет как писал; очередь перед записью смотрит на хвост живых сообщений сервера
 * и пропускает начало хода, которое уже лежит там -- ровно ту цепочку, что записал хук. Служебные
 * сообщения шлюза (роль custom) не пишутся вовсе: шлюз сам отдаёт их модели с каждым промптом.
 * Директивы телеги `[[reply_to_current]]` и подобные в память не идут.
 */

const SESSION = "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3";

type Stored = OVMessage & { peer_id?: string };

type Stand = {
  client: OpenVikingClient;
  stored: Stored[];
  contextFails: { value: boolean };
};

/** Сервер, который хранит, что ему прислали, и отдаёт это как живые сообщения. */
function server(): Stand {
  const stored: Stored[] = [];
  const contextFails = { value: false };
  let next = 1;
  const transport: HttpTransport = vi.fn(async (url, init) => {
    const parsed = new URL(url);
    const answer = (body: unknown, status = 200) =>
      new Response(JSON.stringify(status === 200 ? { status: "ok", result: body } : body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (parsed.pathname.endsWith("/messages") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { role: string; parts: OVMessagePart[]; created_at?: string };
      stored.push({
        id: `ov-${next++}`,
        role: body.role,
        parts: body.parts,
        created_at: body.created_at ?? new Date().toISOString(),
      });
      return answer({ session_id: SESSION });
    }
    if (parsed.pathname.endsWith("/context")) {
      if (contextFails.value) {
        return answer({ status: "error", error: { code: "INTERNAL", message: "storage down" } }, 500);
      }
      return answer({
        latest_archive_overview: "",
        pre_archive_abstracts: [],
        messages: stored,
        estimatedTokens: 1,
        stats: {
          totalArchives: 0, includedArchives: 0, droppedArchives: 0, failedArchives: 0,
          activeTokens: 1, archiveTokens: 0, unsummarizedArchives: 0,
        },
      });
    }
    if (parsed.pathname.endsWith("/commit")) {
      return answer({ status: "skipped", archived: false, reason: "all_within_keep_window" });
    }
    if (/\/api\/v1\/sessions\/[^/]+$/.test(parsed.pathname)) {
      return answer({ pending_tokens: 0, unsummarized_archives: 0 });
    }
    return answer({ status: "error", error: { code: "NOT_FOUND", message: parsed.pathname } }, 404);
  });
  const client = new OpenVikingClient("http://127.0.0.1:1933", "ov-key", "main", 5_000, "", "", undefined, {
    transport,
  });
  return { client, stored, contextFails };
}

function engineOver(stand: Stand) {
  const warned: string[] = [];
  const diags: Array<{ stage: string; data: Record<string, unknown> }> = [];
  const engine = createMemoryOpenVikingContextEngine({
    id: "openviking",
    name: "OpenViking",
    cfg: memoryOpenVikingConfigSchema.parse({
      baseUrl: "http://127.0.0.1:1933",
      autoRecall: false,
      emitStandardDiagnostics: true,
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
  });
  return { engine, warned, diags };
}

const RUNTIME_CONTEXT = {
  role: "custom",
  customType: "openclaw.runtime-context",
  content:
    "OpenClaw runtime context for the active user request in this turn. Do not reply to or describe this context.\n" +
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation info: {\"chat_id\":\"telegram:8248439450\"}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  display: false,
  timestamp: 1_000,
};

const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
const assistant = (text: string, timestamp: number) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp,
});

/** Хук шлюза перед обращением к модели: весь транскрипт и граница новых сообщений. */
async function hook(engine: ReturnType<typeof engineOver>["engine"], transcript: unknown[], prePromptMessageCount: number) {
  await engine.afterTurn?.({
    sessionId: SESSION,
    sessionFile: "/tmp/s.jsonl",
    messages: transcript as never,
    prePromptMessageCount,
    runtimeContext: { sessionKey: "agent:main:telegram:direct:1", senderId: "1" },
  } as never);
}

/** Очередь шлюза в конце хода: только сообщения закрытого хода, без границы и без контекста. */
async function queue(engine: ReturnType<typeof engineOver>["engine"], closedTurn: unknown[], key: string) {
  return await engine.commitTurn?.({
    advancementKey: key,
    messages: closedTurn as never,
    sessionId: SESSION,
    sessionKey: "agent:main:telegram:direct:1",
  } as never);
}

function recorded(stand: Stand): Array<[string, string]> {
  return stand.stored.map((m) => [
    m.role,
    m.parts
      .map((p) => (p.type === "text" ? p.text ?? "" : `tool:${p.tool_id ?? p.tool_name ?? "?"}`))
      .join(" | "),
  ]);
}

describe("ход записывается один раз", () => {
  it("служебное сообщение шлюза не пишется, вопрос пишет хук, ответ дописывает очередь", async () => {
    const stand = server();
    const { engine, diags } = engineOver(stand);
    const history = [user("прошлый вопрос", 1), assistant("прошлый ответ", 2)];
    const transcript = [...history, RUNTIME_CONTEXT, user("день сегодня солнечный", 3)];

    await hook(engine, transcript, history.length);
    expect(recorded(stand)).toEqual([["user", "день сегодня солнечный"]]);

    const closed = [user("день сегодня солнечный", 3), assistant("[[reply_to_current]] Ох уж это солнце", 4)];
    const result = await queue(engine, closed, "adv-1");
    expect(result?.status).toBe("committed");
    expect(recorded(stand)).toEqual([
      ["user", "день сегодня солнечный"],
      ["assistant", "Ох уж это солнце"],
    ]);
    expect(diags.filter((d) => d.stage === "afterTurn_dedupe").at(-1)?.data).toMatchObject({
      path: "commitTurn",
      skipped: 1,
      recorded: 1,
    });
  });

  it("после рестарта шлюза очередь всё равно не дублирует: правда в хвосте сервера, не в памяти", async () => {
    const stand = server();
    const first = engineOver(stand);
    const history = [user("прошлый вопрос", 1), assistant("прошлый ответ", 2)];
    await hook(first.engine, [...history, RUNTIME_CONTEXT, user("вопрос", 3)], history.length);
    expect(recorded(stand)).toEqual([["user", "вопрос"]]);

    const second = engineOver(stand);
    await queue(second.engine, [user("вопрос", 3), assistant("ответ", 4)], "adv-2");
    expect(recorded(stand)).toEqual([
      ["user", "вопрос"],
      ["assistant", "ответ"],
    ]);
  });

  it("ход с инструментом: хук пишет вопрос и результат инструмента по частям, очередь -- только ответ", async () => {
    const stand = server();
    const { engine } = engineOver(stand);
    const history = [user("прошлый вопрос", 1), assistant("прошлый ответ", 2)];
    const toolCall = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: { command: "date" } }],
      timestamp: 4,
    };
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "exec",
      content: [{ type: "text", text: "Tue Oct 7" }],
      timestamp: 5,
    };
    const question = user("какой сегодня день", 3);

    await hook(engine, [...history, RUNTIME_CONTEXT, question], history.length);
    await hook(engine, [...history, RUNTIME_CONTEXT, question, toolCall, toolResult], history.length + 2);
    expect(recorded(stand)).toEqual([
      ["user", "какой сегодня день"],
      ["assistant", "tool:call-1"],
    ]);

    await queue(engine, [question, toolCall, toolResult, assistant("Сегодня вторник", 6)], "adv-3");
    expect(recorded(stand)).toEqual([
      ["user", "какой сегодня день"],
      ["assistant", "tool:call-1"],
      ["assistant", "Сегодня вторник"],
    ]);
  });

  it("одинаковые ответы в разных ходах не считаются повтором: сверка идёт только по началу хода", async () => {
    const stand = server();
    const { engine } = engineOver(stand);
    await hook(engine, [RUNTIME_CONTEXT, user("да", 1)], 0);
    await queue(engine, [user("да", 1), assistant("хорошо", 2)], "adv-4");
    const history = [user("да", 1), assistant("хорошо", 2)];
    await hook(engine, [...history, RUNTIME_CONTEXT, user("да", 3)], history.length);
    await queue(engine, [user("да", 3), assistant("хорошо", 4)], "adv-5");
    expect(recorded(stand)).toEqual([
      ["user", "да"],
      ["assistant", "хорошо"],
      ["user", "да"],
      ["assistant", "хорошо"],
    ]);
  });

  it("хук ничего не записал (ход пришёл только очередью) -- очередь пишет ход целиком", async () => {
    const stand = server();
    const { engine } = engineOver(stand);
    await queue(engine, [user("вопрос без хука", 1), assistant("ответ", 2)], "adv-6");
    expect(recorded(stand)).toEqual([
      ["user", "вопрос без хука"],
      ["assistant", "ответ"],
    ]);
  });

  it("сервер не отдал хвост -- очередь пишет ход целиком и предупреждает, ход не теряется", async () => {
    const stand = server();
    const { engine, warned } = engineOver(stand);
    await hook(engine, [RUNTIME_CONTEXT, user("вопрос", 1)], 0);
    stand.contextFails.value = true;
    await queue(engine, [user("вопрос", 1), assistant("ответ", 2)], "adv-7");
    expect(recorded(stand)).toEqual([
      ["user", "вопрос"],
      ["user", "вопрос"],
      ["assistant", "ответ"],
    ]);
    expect(warned.join("\n")).toMatch(/tail/);
  });

  it("директивы телеги не идут в память, текст ответа остаётся", async () => {
    const stand = server();
    const { engine } = engineOver(stand);
    await queue(
      engine,
      [user("скажи голосом", 1), assistant("[[reply_to:4353]] [[audio_as_voice]] Говорю голосом", 2)],
      "adv-8",
    );
    expect(recorded(stand)).toEqual([
      ["user", "скажи голосом"],
      ["assistant", "Говорю голосом"],
    ]);
  });
});
