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

function reader(branch: BranchRow[]): SessionTranscriptReader {
  return {
    readVisiblePage: async (limits) => {
      const start = limits?.cursor ? Number(limits.cursor) : 0;
      return { kind: "page", cursor: String(branch.length), rows: branch.slice(start), hasMore: false };
    },
    selectModelVisible: (rows) => rows,
  };
}

type Stored = OVMessage;

function server(
  options: {
    totalArchives?: number;
    stored?: Stored[];
    refuse?: (text: string) => number | undefined;
    // As the server: a session never written to is unknown to every read (routers/sessions.py
    // 267-350, auto_create=False -> NOT_FOUND); the first write creates it (506, 555).
    unknownUntilWritten?: boolean;
    contextBody?: unknown;
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

    const first = await catchUp({ client, ovSessionId: "s1", reader: reader(branch), place: "settled", peerIdOf: () => undefined, logger: log });
    const second = await catchUp({ client, ovSessionId: "s1", reader: reader(branch), place: "settled", peerIdOf: () => undefined, logger: log });

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
    await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch.slice(0, 2)), place: "settled", peerIdOf: () => undefined, logger: logger() });

    const restarted = createSessionCatchUp();
    const outcome = await restarted({ client, ovSessionId: "s1", reader: reader(branch), place: "settled", peerIdOf: () => undefined, logger: logger() });

    expect(outcome).toEqual({ kind: "wrote", written: 2, lost: 0 });
    expect(textsOf(stored)).toEqual(["привет", "здравствуй", "как дела?", "хорошо"]);
  });

  it("отказ сервера по сути -- громкая потеря, остальное пишется, второй раз не пробует", async () => {
    const branch = [row("u1", "user", "плохое", T0), row("a1", "assistant", "ответ", T0 + 1_000)];
    const { client, stored } = server({ refuse: (text) => (text === "плохое" ? 400 : undefined) });
    const catchUp = createSessionCatchUp();
    const log = logger();

    const first = await catchUp({ client, ovSessionId: "s1", reader: reader(branch), place: "settled", peerIdOf: () => undefined, logger: log });
    await catchUp({ client, ovSessionId: "s1", reader: reader(branch), place: "settled", peerIdOf: () => undefined, logger: log });

    expect(first).toEqual({ kind: "wrote", written: 1, lost: 1 });
    expect(textsOf(stored)).toEqual(["ответ"]);
    expect(client.addSessionMessage).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("u1"));
  });

  it("временный сбой -- стоп; следующий раз дописывает с того же места без дублей", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    let down = true;
    const { client, stored } = server({ refuse: (text) => (down && text === "здравствуй" ? 503 : undefined) });
    const catchUp = createSessionCatchUp();

    const first = await catchUp({ client, ovSessionId: "s1", reader: reader(branch), place: "settled", peerIdOf: () => undefined, logger: logger() });
    down = false;
    const second = await catchUp({ client, ovSessionId: "s1", reader: reader(branch), place: "settled", peerIdOf: () => undefined, logger: logger() });

    expect(first).toMatchObject({ kind: "stopped", written: 1 });
    expect(second).toEqual({ kind: "wrote", written: 1, lost: 0 });
    expect(textsOf(stored)).toEqual(["привет", "здравствуй"]);
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

    const outcome = await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch), place: "settled", peerIdOf: () => undefined, logger: log });

    expect(outcome).toMatchObject({ kind: "skipped" });
    expect(client.addSessionMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("новая беседа: сервер не знает сессию (404) -- пишется ветка, сессия создаётся первой записью", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    const { client, stored } = server({ unknownUntilWritten: true });

    const outcome = await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch), place: "settled", peerIdOf: () => undefined, logger: logger() });

    expect(outcome).toEqual({ kind: "wrote", written: 2, lost: 0 });
    expect(textsOf(stored)).toEqual(["привет", "здравствуй"]);
  });

  it("ответ сервера без сообщений или счёта архивов -- не «свежая»: ничего не пишется, громко", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    const { client } = server({ contextBody: {} });
    const log = logger();

    const outcome = await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch), place: "settled", peerIdOf: () => undefined, logger: log });

    expect(outcome).toMatchObject({ kind: "skipped" });
    expect(client.addSessionMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("свежая сессия без архивов -- пишет ветку целиком", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    const { client, stored } = server();

    await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch), place: "settled", peerIdOf: () => undefined, logger: logger() });

    expect(textsOf(stored)).toEqual(["привет", "здравствуй"]);
  });

  it("сверяет остаток, который вызывающий уже прочитал, а не читает его заново", async () => {
    const branch = [row("u1", "user", "привет", T0), row("a1", "assistant", "здравствуй", T0 + 1_000)];
    const { client } = server();
    const remainder = { messages: [] as Stored[], totalArchives: 0 };

    await createSessionCatchUp()({ client, ovSessionId: "s1", reader: reader(branch), place: "settled", remainder, peerIdOf: () => undefined, logger: logger() });

    expect(client.getSessionContext).not.toHaveBeenCalled();
  });
});
