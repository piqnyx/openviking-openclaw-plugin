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
