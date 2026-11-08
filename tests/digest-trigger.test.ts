// The news digest's service trigger (digest PLAN, stage 6). A user turn whose first line is the
// marker was sent by a script only to start Eva's turn; the next line names the kind of turn
// ("Эва спрашивает Вита, рассказать ли новости дня" and three more). Memory keeps that phrase and
// not the marker -- the graphiti plugin's messageRules turn the same message into the same phrase,
// and the web hides it by the same first line (gateway fork patch 59).
import { describe, expect, it } from "vitest";

import { prepareRecallQuery } from "../auto-recall.js";
import { extractNewTurnMessages, sanitizeUserTextForCapture } from "../text-utils.js";

const PHRASE = "Эва спрашивает Вита, рассказать ли новости дня";

describe("digest service trigger", () => {
  it("keeps the phrase after the marker line and drops the marker", () => {
    expect(sanitizeUserTextForCapture(`::digest-trigger::\n${PHRASE}`)).toBe(PHRASE);
  });

  it("finds the marker under injected context blocks too", () => {
    const injected = `<graphiti-context>Relevant facts</graphiti-context>\n::digest-trigger::\n${PHRASE}`;
    expect(sanitizeUserTextForCapture(injected)).toBe(PHRASE);
  });

  it("drops a trigger with nothing after the marker", () => {
    expect(sanitizeUserTextForCapture("::digest-trigger::")).toBe("");
    expect(sanitizeUserTextForCapture("  ::digest-trigger::\n  ")).toBe("");
  });

  it("leaves the marker where it is not the head of the message, or is glued to a word", () => {
    expect(sanitizeUserTextForCapture("а что за ::digest-trigger:: такой?")).toBe(
      "а что за ::digest-trigger:: такой?",
    );
    expect(sanitizeUserTextForCapture("::digest-trigger::рядом")).toBe("::digest-trigger::рядом");
  });

  // Since the gateway's model-only prompt context (digest PLAN-rasskaz, 08.11) the model sees the
  // task and the paper after the trigger, in the same message -- and so does the turn's recall. The
  // search takes the message up to the end of the phrase line; what the turn records comes from the
  // transcript, which never holds the paper, and is cleaned as before.
  const TELL = "Эва по своей инициативе рассказывает Виту новости дня";
  const PAPER = "Служебное задание на этот ход.\n\n### Тема\n\nТекст. *[Канал](https://t.me/chan/1)*";
  const QUEUED =
    "[Queued user message from a previous active turn; preserved as context only. " +
    "Continue with the active prompt below.]";
  const query = (text: string) => prepareRecallQuery(text).query;

  it("searches by the phrase line, not by the model-only context after it", () => {
    expect(query(`::digest-trigger::\n${TELL}\n\n${PAPER}`)).toBe(TELL);
  });

  it("searches by the phrase under injected memory blocks and a timestamp too", () => {
    const injected =
      `[Sun 2026-11-08 13:00 GMT+4] <relevant-memories>старое</relevant-memories>\n\n` +
      `<graphiti-context>факты</graphiti-context>\n\n::digest-trigger::\n${TELL}\n\n${PAPER}`;
    expect(query(injected)).toBe(TELL);
  });

  // The gateway may put more than memory blocks in front of the trigger: a queued message of Vit's
  // merged in, another plugin's block. The search keeps them as before; the paper still goes.
  it("cuts the paper after a trigger that follows text memory does not know", () => {
    const queued = `${QUEUED}\nну что там?`;
    expect(query(`${queued}\n\n::digest-trigger::\n${TELL}\n\n${PAPER}`)).toBe(
      `${queued.replace(/\s+/g, " ")} ::digest-trigger:: ${TELL}`,
    );
    const block = "<standing_intents>\nнапоминать про лекарства\n</standing_intents>";
    expect(query(`${block}\n\n::digest-trigger::\n${TELL}\n\n${PAPER}`)).toBe(
      `${block.replace(/\s+/g, " ")} ::digest-trigger:: ${TELL}`,
    );
  });

  it("takes the phrase from the line right after the marker, never from the paper", () => {
    expect(query(`::digest-trigger::\n\n${PAPER}`)).toBe("");
    expect(query(`::digest-trigger::\u00a0\n${TELL}\n\n${PAPER}`)).toBe(TELL);
  });

  it("searches an ordinary message of several lines whole", () => {
    expect(query("Привет\n\nкак дела?\nчто нового")).toBe("Привет как дела? что нового");
  });

  it("records every word of Vit's after a trigger merged in front, as before", () => {
    const merged = `${QUEUED}\n::digest-trigger::\n${TELL}\n\nа расскажи про погоду`;
    const { messages } = extractNewTurnMessages(
      [{ role: "user", content: [{ type: "text", text: merged }] }],
      0,
    );
    expect(messages).toEqual([{ role: "user", parts: [{ type: "text", text: merged.replace(/\s+/g, " ") }] }]);
  });

  it("records Eva's answer as before: a leading marker dropped, nothing cut", () => {
    const { messages } = extractNewTurnMessages(
      [{ role: "assistant", content: [{ type: "text", text: `::digest-trigger::\n${TELL}\n\nВот новости.` }] }],
      0,
    );
    expect(messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: `${TELL} Вот новости.` }] }]);
  });

  it("records the phrase, not the marker, for the user turn of a digest", () => {
    const { messages } = extractNewTurnMessages(
      [
        { role: "user", content: [{ type: "text", text: `::digest-trigger::\n${PHRASE}` }] },
        { role: "assistant", content: [{ type: "text", text: "Почтальон приходил. Рассказать?" }] },
      ],
      0,
    );
    expect(messages).toEqual([
      { role: "user", parts: [{ type: "text", text: PHRASE }] },
      { role: "assistant", parts: [{ type: "text", text: "Почтальон приходил. Рассказать?" }] },
    ]);
  });
});
