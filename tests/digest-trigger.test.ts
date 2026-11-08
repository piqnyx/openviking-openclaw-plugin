// The news digest's service trigger (digest PLAN, stage 6). A user turn whose first line is the
// marker was sent by a script only to start Eva's turn; the next line names the kind of turn
// ("Эва спрашивает Вита, рассказать ли новости дня" and three more). Memory keeps that phrase and
// not the marker -- the graphiti plugin's messageRules turn the same message into the same phrase,
// and the web hides it by the same first line (gateway fork patch 59).
import { describe, expect, it } from "vitest";

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
  // task and the paper after the trigger, in the same message -- and so does recall. Memory takes
  // the phrase line only; what the script appended for the model stays out of the search.
  const TELL = "Эва по своей инициативе рассказывает Виту новости дня";
  const PAPER = "Служебное задание на этот ход.\n\n### Тема\n\nТекст. *[Канал](https://t.me/chan/1)*";

  it("keeps only the phrase line when model-only context follows the trigger", () => {
    expect(sanitizeUserTextForCapture(`::digest-trigger::\n${TELL}\n\n${PAPER}`)).toBe(TELL);
  });

  it("keeps only the phrase line under injected memory blocks too", () => {
    const injected =
      `<relevant-memories>старое</relevant-memories>\n\n<graphiti-context>факты</graphiti-context>\n\n` +
      `::digest-trigger::\n${TELL}\n\n${PAPER}`;
    expect(sanitizeUserTextForCapture(injected)).toBe(TELL);
  });

  it("leaves an ordinary message of several lines whole", () => {
    expect(sanitizeUserTextForCapture("Привет\n\nкак дела?\nчто нового")).toBe("Привет как дела? что нового");
  });

  // The gateway may put more than known memory blocks in front of the trigger: a queued message of
  // Vit's merged in, another plugin's block. What is in front stays as it was; the paper still goes.
  it("cuts the paper after a trigger that follows text memory does not know", () => {
    const queued =
      "[Queued user message from a previous active turn; preserved as context only. " +
      "Continue with the active prompt below.]\nну что там?";
    expect(sanitizeUserTextForCapture(`${queued}\n\n::digest-trigger::\n${TELL}\n\n${PAPER}`)).toBe(
      `${queued.replace(/\s+/g, " ")} ${TELL}`,
    );
    const block = "<standing_intents>\nнапоминать про лекарства\n</standing_intents>";
    expect(sanitizeUserTextForCapture(`${block}\n\n::digest-trigger::\n${TELL}\n\n${PAPER}`)).toBe(
      `${block.replace(/\s+/g, " ")} ${TELL}`,
    );
  });

  it("takes the phrase from the line right after the marker, never from the paper", () => {
    expect(sanitizeUserTextForCapture(`::digest-trigger::\n\n${PAPER}`)).toBe("");
    expect(sanitizeUserTextForCapture(`::digest-trigger:: \n${TELL}\n\n${PAPER}`)).toBe(TELL);
  });

  it("leaves Eva's own words alone, marker or not", () => {
    const { messages } = extractNewTurnMessages(
      [
        { role: "user", content: [{ type: "text", text: `::digest-trigger::\n${TELL}` }] },
        { role: "assistant", content: [{ type: "text", text: `::digest-trigger::\n${TELL}\n\nВот новости.` }] },
      ],
      0,
    );
    expect(messages).toEqual([
      { role: "user", parts: [{ type: "text", text: TELL }] },
      { role: "assistant", parts: [{ type: "text", text: `::digest-trigger:: ${TELL} Вот новости.` }] },
    ]);
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
