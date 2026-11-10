import { describe, expect, it } from "vitest";

import { planTranscriptCatchUp, type BranchRow } from "../services/transcript-catch-up.js";

/*
 * PLAN-krug Р1, шаг 7а: «догнать» -- строки видимой ветки шлюза после новейшей строки, которую
 * Викинг уже держит, в нынешней форме захвата; у каждого сообщения -- номера строк, из которых оно
 * собрано (номер, под которым строка записана впервые, переживает перезапись шлюза), и своё время.
 * Повтор по номеру ничего не дописывает -- вместо угадывания по хвосту и отпечатков ходов.
 */

const T0 = Date.UTC(2026, 10, 9, 10, 0, 0);

function row(id: string, message: Record<string, unknown>, firstEntryId = id): BranchRow {
  return { entryId: id, firstEntryId, message };
}

function user(id: string, text: string, at: number): BranchRow {
  return row(id, { role: "user", content: text, timestamp: at });
}

function answer(id: string, text: string, at: number): BranchRow {
  return row(id, { role: "assistant", content: [{ type: "text", text }], timestamp: at });
}

function toolCall(id: string, callId: string, at: number): BranchRow {
  return row(id, {
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: "web_search", arguments: { query: "погода" } }],
    timestamp: at,
  });
}

function toolResult(id: string, callId: string, text: string, at: number): BranchRow {
  return row(id, {
    role: "toolResult",
    toolCallId: callId,
    toolName: "web_search",
    content: [{ type: "text", text }],
    timestamp: at,
  });
}

const iso = (at: number) => new Date(at).toISOString();

describe("«догнать»: что писать в Викинг", () => {
  it("пишет строки после новейшей, что уже в Викинге, каждую со своим номером и временем", () => {
    const rows = [
      user("u1", "привет", T0),
      answer("a1", "здравствуй", T0 + 1_000),
      user("u2", "как дела?", T0 + 60_000),
      answer("a2", "хорошо", T0 + 61_000),
    ];

    const plan = planTranscriptCatchUp({ rows, seenIds: new Set(["u1", "a1"]), holdTrailingQuestion: false });

    expect(plan.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "как дела?" }], sourceIds: ["u2"], createdAt: iso(T0 + 60_000) },
      { role: "assistant", parts: [{ type: "text", text: "хорошо" }], sourceIds: ["a2"], createdAt: iso(T0 + 61_000) },
    ]);
  });

  it("ничего не дописывает, когда Викинг держит всё", () => {
    const rows = [user("u1", "привет", T0), answer("a1", "здравствуй", T0 + 1_000)];

    expect(planTranscriptCatchUp({ rows, seenIds: new Set(["u1", "a1"]), holdTrailingQuestion: false }).messages).toEqual([]);
  });

  it("перезаписанная строка зовётся номером, под которым записана впервые, и второй раз не пишется", () => {
    const rows = [
      user("u1", "привет", T0),
      row("a1-again", { role: "assistant", content: [{ type: "text", text: "здравствуй" }], timestamp: T0 + 1_000 }, "a1"),
      user("u2", "ещё вопрос", T0 + 60_000),
    ];

    const plan = planTranscriptCatchUp({ rows, seenIds: new Set(["u1", "a1"]), holdTrailingQuestion: false });

    expect(plan.messages.map((message) => message.sourceIds)).toEqual([["u2"]]);
  });

  it("круг инструментов -- одно сообщение с номерами своих строк; два круга не слипаются", () => {
    const rows = [
      user("u1", "погода?", T0),
      toolCall("c1", "call-1", T0 + 1_000),
      toolResult("r1", "call-1", "дождь", T0 + 2_000),
      toolCall("c2", "call-2", T0 + 3_000),
      toolResult("r2", "call-2", "ветер", T0 + 4_000),
      answer("a1", "дождь и ветер", T0 + 5_000),
    ];

    const plan = planTranscriptCatchUp({ rows, seenIds: new Set(), holdTrailingQuestion: false });

    expect(plan.messages.map((message) => [message.role, message.sourceIds, message.createdAt])).toEqual([
      ["user", ["u1"], iso(T0)],
      ["assistant", ["r1"], iso(T0 + 2_000)],
      ["assistant", ["r2"], iso(T0 + 4_000)],
      ["assistant", ["a1"], iso(T0 + 5_000)],
    ]);
    expect(plan.messages[1]?.parts).toEqual([
      {
        type: "tool",
        tool_id: "call-1",
        tool_name: "web_search",
        tool_input: { query: "погода" },
        tool_output: "дождь",
        tool_status: "completed",
      },
    ]);
  });

  it("одинокий вопрос в конце ждёт, когда велено держать (посреди хода), и пишется иначе", () => {
    const rows = [user("u1", "привет", T0), answer("a1", "здравствуй", T0 + 1_000), user("u2", "ты тут?", T0 + 60_000)];
    const seenIds = new Set(["u1", "a1"]);

    const settled = planTranscriptCatchUp({ rows, seenIds, holdTrailingQuestion: true });
    const working = planTranscriptCatchUp({ rows, seenIds, holdTrailingQuestion: false });

    expect(settled).toEqual({ messages: [], heldQuestionId: "u2" });
    expect(working.messages.map((message) => message.sourceIds)).toEqual([["u2"]]);
  });

  // Проверяющий плагина (10.11): вопрос и дописка без ответа в конце ветки -- держатся оба; первый, записанный
  // раньше ответа, шёл бы в окно следующего хода рядом с тем же вопросом в подсказке шлюза.
  it("несколько вопросов без ответа в конце -- держатся все, пишутся иначе", () => {
    const rows = [
      user("u1", "привет", T0),
      answer("a1", "здравствуй", T0 + 1_000),
      user("u2", "ты тут?", T0 + 60_000),
      user("u3", "и ещё вот что", T0 + 61_000),
    ];
    const seenIds = new Set(["u1", "a1"]);

    const settled = planTranscriptCatchUp({ rows, seenIds, holdTrailingQuestion: true });
    const working = planTranscriptCatchUp({ rows, seenIds, holdTrailingQuestion: false });

    expect(settled).toEqual({ messages: [], heldQuestionId: "u3" });
    expect(working.messages.flatMap((message) => message.sourceIds)).toEqual(["u2", "u3"]);
  });

  it("без единой строки в Викинге пишет ветку целиком", () => {
    const rows = [user("u1", "привет", T0), answer("a1", "здравствуй", T0 + 1_000)];

    expect(
      planTranscriptCatchUp({ rows, seenIds: new Set(), holdTrailingQuestion: false }).messages.map((message) => message.sourceIds),
    ).toEqual([["u1"], ["a1"]]);
  });

  it("чистит текст как нынешний захват", () => {
    const rows = [
      user("u1", "<relevant-memories>старое</relevant-memories>вопрос", T0),
      answer("a1", "[[reply_to_current]] ответ", T0 + 1_000),
    ];

    const plan = planTranscriptCatchUp({ rows, seenIds: new Set(), holdTrailingQuestion: false });

    expect(plan.messages.map((message) => message.parts)).toEqual([
      [{ type: "text", text: "вопрос" }],
      [{ type: "text", text: "ответ" }],
    ]);
  });
});
