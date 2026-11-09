import { describe, expect, it, vi } from "vitest";

import { OpenVikingRequestError, type OVMessage } from "../client.js";
import type { SessionTranscriptReader } from "../services/branch-reader.js";
import { createSessionCatchUp } from "../services/catch-up-session.js";
import type { BranchRow } from "../services/transcript-catch-up.js";

/*
 * PLAN-krug Р1, шаг 7б: «догнать» для сессии -- что Викинг держит (номера в его остатке, а
 * после записи -- память процесса), что дописать, и запись по одному сообщению по очереди.
 * Повтор ничего не дублирует; отказ сервера по сути -- громкая потеря и дальше; временный сбой --
 * стоп, следующий раз с того же места. Всю переписку заново не пишет никогда: пустой остаток при
 * архивах или остаток без номеров -- громкий пропуск (это 7г).
 */

const T0 = Date.UTC(2026, 10, 9, 10, 0, 0);

function row(id: string, role: "user" | "assistant", text: string, at: number): BranchRow {
  return {
    entryId: id,
    firstEntryId: id,
    message: role === "user" ? { role, content: text, timestamp: at } : { role, content: [{ type: "text", text }], timestamp: at },
  };
}

/**
 * As the gateway's reader: the cursor names the last row read (its position and id); under a fence
 * (the current question's position) only rows before it are visible, and a cursor on the fence or
 * past it is an error, not a reset; a cursor whose row is no longer there is answered with a reset to
 * the branch's start (anchor_missing) -- the fence is checked before the anchor, as the gateway does
 * (session-accessor.sqlite-active-events.ts 225-253).
 */
function reader(branch: BranchRow[], options: { fence?: number } = {}) {
  const cursors: Array<string | undefined> = [];
  const cursorAt = (index: number) => (index < 0 ? "-1:" : `${index}:${branch[index]?.firstEntryId ?? ""}`);
  const value: SessionTranscriptReader = {
    readVisiblePage: async (limits) => {
      cursors.push(limits?.cursor);
      const [position, anchor] = (limits?.cursor ?? "-1:").split(":");
      const last = Number(position);
      if (options.fence !== undefined && last >= options.fence) {
        throw Object.assign(new Error("Transcript read cursor has crossed the current-turn admission fence"), {
          name: "SessionTranscriptReadFenceError",
        });
      }
      if (last >= 0 && branch[last]?.firstEntryId !== anchor) {
        return { kind: "reset", cursor: "-1:", reason: "anchor_missing" };
      }
      const end = options.fence !== undefined ? Math.min(options.fence, branch.length) : branch.length;
      const rows = branch.slice(last + 1, end);
      return { kind: "page", cursor: cursorAt(last + rows.length), rows, hasMore: false };
    },
    selectModelVisible: (rows) => rows,
  };
  return Object.assign(value, { cursors });
}

type Stored = OVMessage;

function toolCall(id: string, callId: string, at: number): BranchRow {
  return {
    entryId: id,
    firstEntryId: id,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "web_search", arguments: { query: "погода" } }],
      timestamp: at,
    },
  };
}

function toolResult(id: string, callId: string, text: string, at: number): BranchRow {
  return {
    entryId: id,
    firstEntryId: id,
    message: { role: "toolResult", toolCallId: callId, toolName: "web_search", content: [{ type: "text", text }], timestamp: at },
  };
}

/** A message Viking already holds, written from the gateway row `id`. */
function held(id: string, role: string, text: string): Stored {
  return { id: `ov-${id}`, role, parts: [{ type: "text", text }], created_at: "", source_message_ids: [id] };
}

function server(
  options: {
    totalArchives?: number;
    stored?: Stored[];
    refuse?: (text: string) => number | undefined;
    // As the server: a session never written to is unknown to every read (routers/sessions.py
    // 267-350, auto_create=False -> NOT_FOUND); the first write creates it (506, 555).
    unknownUntilWritten?: boolean;
    contextBody?: unknown;
    // The write is kept although the answer is a failure (a write answered after the client's own
    // deadline: the server waits up to 30 s for the session lock, session.py 86, 1207-1209).
    keepRefused?: boolean;
  } = {},
) {
  const stored: Stored[] = options.stored ?? [];
  let created = !options.unknownUntilWritten;
  const client = {
    addSessionMessage: vi.fn(
      async (
        _session: string,
        role: string,
        parts: Array<{ type: string; text?: string }>,
        _actor?: string,
        createdAt?: string,
        _peer?: string,
        sourceIds?: readonly string[],
      ) => {
        const text = parts.map((part) => part.text ?? "").join(" ");
        const status = options.refuse?.(text);
        if (status && options.keepRefused) {
          stored.push({ id: `m${stored.length + 1}`, role, parts: parts as OVMessage["parts"], created_at: createdAt ?? "", ...(sourceIds ? { source_message_ids: [...sourceIds] } : {}) });
        }
        if (status) {
          throw new OpenVikingRequestError(`OpenViking request failed: refused ${text}`, status, status >= 500 ? "UNAVAILABLE" : "INVALID_ARGUMENT");
        }
        created = true;
        stored.push({
          id: `m${stored.length + 1}`,
          role,
          parts: parts as OVMessage["parts"],
          created_at: createdAt ?? "",
          ...(sourceIds ? { source_message_ids: [...sourceIds] } : {}),
        });
      },
    ),
    // As the server: one append under one lock -- all or none; a message it refuses refuses the batch
    // before anything is written (routers/sessions.py 541-590, session.py 1185-1230).
    addSessionMessages: vi.fn(
      async (
        _session: string,
        messages: ReadonlyArray<{ role: string; parts: Array<{ type: string; text?: string }>; createdAt?: string; sourceMessageIds?: readonly string[] }>,
      ) => {
        const texts = messages.map((message) => message.parts.map((part) => part.text ?? "").join(" "));
        const statuses = texts.map((text) => options.refuse?.(text)).filter((status): status is number => status !== undefined);
        const status = statuses.find((candidate) => candidate < 500) ?? statuses[0];
        const keep = () => {
          created = true;
          for (const message of messages) {
            stored.push({
              id: `m${stored.length + 1}`,
              role: message.role,
              parts: message.parts as OVMessage["parts"],
              created_at: message.createdAt ?? "",
              ...(message.sourceMessageIds ? { source_message_ids: [...message.sourceMessageIds] } : {}),
            });
          }
        };
        if (status && status >= 500 && options.keepRefused) {
          keep();
        }
        if (status) {
          throw new OpenVikingRequestError("OpenViking request failed: refused batch", status, status >= 500 ? "UNAVAILABLE" : "INVALID_ARGUMENT");
        }
        keep();
      },
    ),
    getSessionContext: vi.fn(async () => {
      if (!created) {
        throw new OpenVikingRequestError("OpenViking request failed [NOT_FOUND]: Session not found", 404, "NOT_FOUND");
      }
      if (options.contextBody !== undefined) {
        return options.contextBody as never;
      }
      return {
        latest_archive_overview: "",
        pre_archive_abstracts: [],
        messages: [...stored],
        estimatedTokens: 0,
        stats: { totalArchives: options.totalArchives ?? 0 },
      };
    }),
  };
  return { client, stored };
}

const textsOf = (stored: Stored[]) => stored.map((message) => message.parts.map((part) => (part as { text?: string }).text).join(" "));
const logger = () => ({ info: vi.fn(), warn: vi.fn() });

describe("«догнать» для сессии", () => {
  it("дописывает новые строки ветки с номерами, повтор ничего не дублирует", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    const { client, stored } = server();
    const catchUp = createSessionCatchUp();
    const log = logger();

    const first = await catchUp({ client, ovSessionId: "s1", reader: reader(branch), holdTrailingQuestion: false, memory: "open", peerIdOf: () => undefined, logger: log });
    const second = await catchUp({ client, ovSessionId: "s1", reader: reader(branch), holdTrailingQuestion: false, memory: "open", peerIdOf: () => undefined, logger: log });

    expect(first).toEqual({ kind: "wrote", written: 2, lost: 0 });
    expect(second).toEqual({ kind: "wrote", written: 0, lost: 0 });
    expect(stored.map((message) => message.source_message_ids)).toEqual([["u1"], ["a1"]]);
  });

  it("после перезапуска берёт закладку из остатка Викинга и дописывает только новое", async () => {
    const branch = [
      row("u1", "user", "привет", T0),
      row("a1", "assistant", "здравствуй", T0 + 1_000),
      row("u2", "user", "как дела?", T0 + 60_000),
      row("a2", "assistant", "хорошо", T0 + 61_000),
    ];
    const { client, stored } = server();
    await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch.slice(0, 2)), holdTrailingQuestion: false, memory: "open", peerIdOf: () => undefined, logger: logger() });

    const restarted = createSessionCatchUp();
    const outcome = await restarted({ client, ovSessionId: "s1", reader: reader(branch), holdTrailingQuestion: false, memory: "open", peerIdOf: () => undefined, logger: logger() });

    expect(outcome).toEqual({ kind: "wrote", written: 2, lost: 0 });
    expect(textsOf(stored)).toEqual(["привет", "здравствуй", "как дела?", "хорошо"]);
  });

  it("отказ сервера по сути -- громкая потеря, остальное пишется, второй раз не пробует", async () => {
    const branch = [row("u1", "user", "плохое", T0), row("a1", "assistant", "ответ", T0 + 1_000)];
    const { client, stored } = server({ refuse: (text) => (text === "плохое" ? 400 : undefined) });
    const catchUp = createSessionCatchUp();
    const log = logger();

    const first = await catchUp({ client, ovSessionId: "s1", reader: reader(branch), holdTrailingQuestion: false, memory: "open", peerIdOf: () => undefined, logger: log });
    await catchUp({ client, ovSessionId: "s1", reader: reader(branch), holdTrailingQuestion: false, memory: "open", peerIdOf: () => undefined, logger: log });

    expect(first).toEqual({ kind: "wrote", written: 1, lost: 1 });
    expect(textsOf(stored)).toEqual(["ответ"]);
    expect(client.addSessionMessage).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("u1"));
  });

  it("временный сбой -- стоп; следующий раз дописывает с того же места без дублей", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000), row("u2", "user", "как дела?", T0 + 2_000)];
    let down = true;
    const { client, stored } = server({ refuse: (text) => (down && text === "здравствуй" ? 503 : undefined) });
    const catchUp = createSessionCatchUp();
    const base = { client, ovSessionId: "s1", holdTrailingQuestion: false, memory: "open" as const, peerIdOf: () => undefined };

    // The chunk fails as a whole; the next call writes it one by one and stops at the failing row.
    const asChunk = await catchUp({ ...base, reader: reader(branch), logger: logger() });
    const first = await catchUp({ ...base, reader: reader(branch), logger: logger() });
    down = false;
    const second = await catchUp({ ...base, reader: reader(branch), logger: logger() });

    expect(asChunk).toMatchObject({ kind: "stopped", written: 0 });
    expect(first).toMatchObject({ kind: "stopped", written: 1 });
    expect(second).toEqual({ kind: "wrote", written: 2, lost: 0 });
    expect(textsOf(stored)).toEqual(["привет", "здравствуй", "как дела?"]);
  });

  it("кусок новых строк -- одним запросом; больше 100 -- кусками по 100 (PLAN-krug К17)", async () => {
    const branch = Array.from({ length: 101 }, (_unused, index) =>
      row(`r${index}`, index % 2 === 0 ? "user" : "assistant", `строка ${index}`, T0 + index * 1_000),
    );
    const { client, stored } = server();

    await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch), holdTrailingQuestion: false, memory: "open", peerIdOf: () => undefined, logger: logger() });

    expect(client.addSessionMessages.mock.calls.map(([, messages]) => messages.length)).toEqual([100]);
    expect(client.addSessionMessage).toHaveBeenCalledTimes(1);
    expect(stored.map((message) => message.source_message_ids?.[0])).toEqual(branch.map((candidate) => candidate.entryId));
  });

  it("отказ куску по сути -- этот кусок по одному, громко только плохое (PLAN-krug К17)", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "плохое", T0 + 1_000), row("u2", "user", "дальше", T0 + 2_000)];
    const { client, stored } = server({ refuse: (text) => (text === "плохое" ? 400 : undefined) });
    const log = logger();

    const outcome = await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch), holdTrailingQuestion: false, memory: "open", peerIdOf: () => undefined, logger: log });

    expect(outcome).toEqual({ kind: "wrote", written: 2, lost: 1 });
    expect(stored.map((message) => message.source_message_ids)).toEqual([["u1"], ["u2"]]);
    const lines = log.warn.mock.calls.map(([line]) => String(line));
    expect(lines.filter((line) => line.includes("a1"))).toHaveLength(1);
    expect(lines.filter((line) => /rows (u1|u2)\b/.test(line))).toEqual([]);
  });

  it.each([
    ["пустой остаток при архивах (после сжатия)", { totalArchives: 1, stored: [] as Stored[] }],
    [
      "остаток без номеров строк (старая сессия)",
      { stored: [{ id: "old", role: "user", parts: [{ type: "text", text: "давнее" }], created_at: "" }] as Stored[] },
    ],
  ])("не переписывает всю переписку: %s -- громкий пропуск", async (_label, setup) => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    const { client } = server(setup);
    const log = logger();

    const outcome = await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch), holdTrailingQuestion: false, memory: "open", peerIdOf: () => undefined, logger: log });

    expect(outcome).toMatchObject({ kind: "skipped" });
    expect(client.addSessionMessage).not.toHaveBeenCalled();
    expect(client.addSessionMessages).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  // PLAN-krug К15, К15б (Вит 09.11: «второй вариант, 30 минут»): the catch-up runs before every model call
  // of a turn, so five failures can come within seconds -- a row is lost only after five failures in a row
  // AND half an hour since its first one; a short failure of the server's writes loses nothing.
  function poisonedBranch() {
    const branch = [
      row("u1", "user", "привет", T0),
      row("a1", "assistant", "ядовитая", T0 + 1_000),
      row("u2", "user", "дальше", T0 + 2_000),
    ];
    const { client, stored } = server({ refuse: (text) => (text === "ядовитая" ? 503 : undefined) });
    let clock = T0;
    const catchUp = createSessionCatchUp({ now: () => clock });
    const log = logger();
    const base = { client, ovSessionId: "s1", holdTrailingQuestion: false, memory: "open" as const, peerIdOf: () => undefined, logger: log };
    const at = async (minutes: number) => {
      clock = T0 + minutes * 60_000;
      await catchUp({ ...base, reader: reader(branch) });
    };
    const ids = () => stored.map((message) => message.source_message_ids);
    return { at, ids, log };
  }

  it("строка, на которой сервер падает раз за разом, -- потеря только после пяти неудач и получаса (PLAN-krug К15б)", async () => {
    const { at, ids, log } = poisonedBranch();

    // The chunk fails at once; then one by one -- the poisonous row fails ten times within 29 minutes.
    await at(0);
    for (let minute = 0; minute <= 29; minute += 3) {
      await at(minute);
    }
    const within = ids();
    await at(30);

    expect(within).toEqual([["u1"]]);
    expect(ids()).toEqual([["u1"], ["u2"]]);
    expect(log.warn.mock.calls.some(([line]) => String(line).includes("30 minutes"))).toBe(true);
  });

  it("полчаса без пяти неудач -- тоже не потеря (PLAN-krug К15б)", async () => {
    const { at, ids } = poisonedBranch();

    await at(0);
    await at(0);
    await at(40);
    const twoOverForty = ids();
    await at(40);
    await at(40);
    const fourOverForty = ids();
    await at(40);

    expect(twoOverForty).toEqual([["u1"]]);
    expect(fourOverForty).toEqual([["u1"]]);
    expect(ids()).toEqual([["u1"], ["u2"]]);
  });

  it("новая беседа: сервер не знает сессию (404) -- пишется ветка, сессия создаётся первой записью", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    const { client, stored } = server({ unknownUntilWritten: true });

    const outcome = await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch), holdTrailingQuestion: false, memory: "open", peerIdOf: () => undefined, logger: logger() });

    expect(outcome).toEqual({ kind: "wrote", written: 2, lost: 0 });
    expect(textsOf(stored)).toEqual(["привет", "здравствуй"]);
  });

  it("ответ сервера без сообщений или счёта архивов -- не «свежая»: ничего не пишется, громко", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    const { client } = server({ contextBody: {} });
    const log = logger();

    const outcome = await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch), holdTrailingQuestion: false, memory: "open", peerIdOf: () => undefined, logger: log });

    expect(outcome).toMatchObject({ kind: "skipped" });
    expect(client.addSessionMessage).not.toHaveBeenCalled();
    expect(client.addSessionMessages).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("огороженная сборка после открытого чтения своего же хода не упирается в ограду", async () => {
    const branch = [
      row("u0", "user", "привет", T0),
      row("a0", "assistant", "здравствуй", T0 + 1_000),
      row("q", "user", "погода?", T0 + 60_000),
      row("a", "assistant", "дождь", T0 + 61_000),
    ];
    const { client, stored } = server({ stored: [held("u0", "user", "привет"), held("a0", "assistant", "здравствуй")] });
    const catchUp = createSessionCatchUp();
    const base = { client, ovSessionId: "s1", holdTrailingQuestion: false, peerIdOf: () => undefined, logger: logger() };

    await catchUp({ ...base, memory: "open", reader: reader(branch) });
    const fenced = await catchUp({
      ...base,
      memory: "fenced",
      reader: reader(branch, { fence: 2 }),
      remainder: { messages: [...stored], totalArchives: 0 },
    });

    expect(fenced).toEqual({ kind: "wrote", written: 0, lost: 0 });
  });

  it("повтор попытки после круга инструментов не пишет вопрос и круг второй раз", async () => {
    const before = [row("u0", "user", "привет", T0), row("a0", "assistant", "здравствуй", T0 + 1_000), row("q", "user", "погода?", T0 + 60_000)];
    const firstAttempt = [...before, toolCall("c1", "call-1", T0 + 61_000), toolResult("r1", "call-1", "дождь", T0 + 62_000)];
    const secondAttempt = [...firstAttempt, toolCall("c2", "call-2", T0 + 63_000), toolResult("r2", "call-2", "ветер", T0 + 64_000)];
    const { client, stored } = server({ stored: [held("u0", "user", "привет"), held("a0", "assistant", "здравствуй")] });
    const catchUp = createSessionCatchUp();
    const base = { client, ovSessionId: "s1", holdTrailingQuestion: false, peerIdOf: () => undefined, logger: logger() };
    const assemble = () =>
      catchUp({ ...base, memory: "fenced", reader: reader(secondAttempt, { fence: 2 }), remainder: { messages: [...stored], totalArchives: 0 } });

    await assemble();
    await catchUp({ ...base, memory: "open", reader: reader(firstAttempt) });
    await assemble();
    await catchUp({ ...base, memory: "open", reader: reader(secondAttempt) });

    expect(stored.map((message) => message.source_message_ids)).toEqual([["u0"], ["a0"], ["q"], ["r1"], ["r2"]]);
  });

  it("открытое чтение без своей памяти начинает с огороженной: после перезапуска ветка не читается целиком дважды", async () => {
    const before = [row("u0", "user", "привет", T0), row("a0", "assistant", "здравствуй", T0 + 1_000), row("q", "user", "погода?", T0 + 60_000)];
    const turn = [...before, toolCall("c1", "call-1", T0 + 61_000), toolResult("r1", "call-1", "дождь", T0 + 62_000)];
    const { client, stored } = server({ stored: [held("u0", "user", "привет"), held("a0", "assistant", "здравствуй")] });
    const catchUp = createSessionCatchUp();
    const base = { client, ovSessionId: "s1", holdTrailingQuestion: false, peerIdOf: () => undefined, logger: logger() };
    const open = reader(turn);

    await catchUp({ ...base, memory: "fenced", reader: reader(turn, { fence: 2 }), remainder: { messages: [...stored], totalArchives: 0 } });
    await catchUp({ ...base, memory: "open", reader: open });

    expect(open.cursors[0]).toBe("1:a0");
  });

  it("после останова записи следующее «догнать» сверяется с сервером: поздно принятая запись второй раз не пишется", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    let late = true;
    const { client, stored } = server({ keepRefused: true, refuse: (text) => (late && text === "здравствуй" ? 504 : undefined) });
    const catchUp = createSessionCatchUp();
    const base = { client, ovSessionId: "s1", holdTrailingQuestion: false, memory: "open" as const, peerIdOf: () => undefined, logger: logger() };

    // The first row alone: the memory then holds it, and the late row is written by itself.
    await catchUp({ ...base, reader: reader([branch[0]!]) });
    await catchUp({ ...base, reader: reader(branch) });
    late = false;
    await catchUp({ ...base, reader: reader(branch) });

    expect(stored.map((message) => message.source_message_ids)).toEqual([["u1"], ["a1"]]);
  });

  it("сверка с сервером после останова не теряется, если следующее «догнать» вышло пропуском (PLAN-krug К19)", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    let late = true;
    const { client, stored } = server({ keepRefused: true, refuse: (text) => (late && text === "здравствуй" ? 504 : undefined) });
    const catchUp = createSessionCatchUp();
    const base = { client, ovSessionId: "s1", holdTrailingQuestion: false, memory: "open" as const, peerIdOf: () => undefined, logger: logger() };
    const rebuilding: SessionTranscriptReader = {
      readVisiblePage: async () => ({ kind: "unavailable", reason: "projection_rebuilding" }),
      selectModelVisible: (rows) => rows,
    };

    // The first row alone: the memory then holds it, and the late row is written by itself.
    await catchUp({ ...base, reader: reader([branch[0]!]) });
    await catchUp({ ...base, reader: reader(branch) });
    late = false;
    // The memory is dirty; this call asks the server, then the branch cannot be read.
    await catchUp({ ...base, reader: rebuilding });
    await catchUp({ ...base, reader: reader(branch) });

    expect(stored.map((message) => message.source_message_ids)).toEqual([["u1"], ["a1"]]);
  });

  it("сброс (без памяти) берёт номера у сервера, а не из памяти, и оставляет память грязной (PLAN-krug К13)", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    const { client, stored } = server();
    const catchUp = createSessionCatchUp();
    const base = { client, ovSessionId: "s1", holdTrailingQuestion: false, peerIdOf: () => undefined, logger: logger() };
    await catchUp({ ...base, memory: "open", reader: reader([branch[0]!]) });
    // A write this memory never saw (another registration of the plugin, before a hot reload).
    stored.push(held("a1", "assistant", "здравствуй"));

    await catchUp({ ...base, memory: "none", reader: reader(branch) });
    const readsAfterReset = client.getSessionContext.mock.calls.length;
    await catchUp({ ...base, memory: "open", reader: reader(branch) });

    expect(stored.map((message) => message.source_message_ids)).toEqual([["u1"], ["a1"]]);
    // Dirty after the reset: the next call asks the server again.
    expect(client.getSessionContext.mock.calls.length).toBeGreaterThan(readsAfterReset);
  });

  it("закладки нет среди строк ветки -- сверка с сервером; сервер тоже ничего из ветки не держит -- громкий пропуск, не вся ветка", async () => {
    const { client } = server({ stored: [held("old1", "user", "давнее"), held("old2", "assistant", "давний ответ")] });
    const catchUp = createSessionCatchUp();
    const log = logger();
    const base = { client, ovSessionId: "s1", holdTrailingQuestion: false, memory: "open" as const, peerIdOf: () => undefined, logger: log };
    // The process knows what it held -- rows no longer on the branch.
    await catchUp({ ...base, reader: reader([row("old1", "user", "давнее", T0), row("old2", "assistant", "давний ответ", T0 + 1_000)]) });
    client.addSessionMessage.mockClear();
    client.addSessionMessages.mockClear();
    client.getSessionContext.mockClear();

    const outcome = await catchUp({
      ...base,
      reader: reader([row("n1", "user", "новое", T0 + 60_000), row("n2", "assistant", "новый ответ", T0 + 61_000)]),
    });

    expect(outcome).toMatchObject({ kind: "skipped" });
    expect(client.getSessionContext).toHaveBeenCalled();
    expect(client.addSessionMessage).not.toHaveBeenCalled();
    expect(client.addSessionMessages).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("одна строка дважды в остатке Викинга -- громкая строка про дубль", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    const { client } = server({ stored: [held("u1", "user", "привет"), held("a1", "assistant", "здравствуй"), held("a1", "assistant", "здравствуй")] });
    const log = logger();

    await createSessionCatchUp()({ client, ovSessionId: "s1", holdTrailingQuestion: false, memory: "open", reader: reader(branch), peerIdOf: () => undefined, logger: log });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("a1"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("twice"));
  });

  it("память сессий вытесняется по давности: главный чат, тронутый недавно, не вылетает первым", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    const { client } = server();
    const catchUp = createSessionCatchUp();
    const touch = (ovSessionId: string) =>
      catchUp({ client, ovSessionId, holdTrailingQuestion: false, memory: "open", reader: reader(branch), peerIdOf: () => undefined, logger: logger() });

    await touch("main");
    for (let other = 0; other < 255; other += 1) {
      await touch(`other-${other}`);
    }
    await touch("main");
    await touch("one-more");
    client.getSessionContext.mockClear();
    await touch("main");

    // Its memory survived: what Viking holds came from it, not from the server.
    expect(client.getSessionContext).not.toHaveBeenCalled();
  });

  it("отложенный одинокий вопрос назван в итоге «догнать» (журнал)", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000), row("u2", "user", "ты тут?", T0 + 60_000)];
    const { client } = server();

    const outcome = await createSessionCatchUp()({ client, ovSessionId: "s1", holdTrailingQuestion: true, memory: "open", reader: reader(branch), peerIdOf: () => undefined, logger: logger() });

    expect(outcome).toEqual({ kind: "wrote", written: 2, lost: 0, heldQuestion: "u2" });
  });

  it("свежая сессия без архивов -- пишет ветку целиком", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    const { client, stored } = server();

    await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch), holdTrailingQuestion: false, memory: "open", peerIdOf: () => undefined, logger: logger() });

    expect(textsOf(stored)).toEqual(["привет", "здравствуй"]);
  });

  it("сверяет остаток, который вызывающий уже прочитал, а не читает его заново", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    const { client } = server();
    const remainder = { messages: [] as Stored[], totalArchives: 0 };

    await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch), holdTrailingQuestion: false, memory: "open", remainder, peerIdOf: () => undefined, logger: logger() });

    expect(client.getSessionContext).not.toHaveBeenCalled();
  });
});
