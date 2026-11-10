// The weather watch's service trigger (piqnyx/weather PLAN, step 5). A user turn whose first line is
// the marker was sent by the watcher only to start Eva's warning; the next line names the kind of turn
// ("Эва по своей инициативе предупреждает Вита о погоде"). Memory keeps that phrase and not the marker,
// as for the digest's trigger -- the graphiti plugin's messageRules turn the same message into the same
// phrase, and the web hides it by the same first line (gateway branch weather/service-markers).
import { describe, expect, it } from "vitest";

import { prepareRecallQuery } from "../auto-recall.js";
import { extractNewTurnMessages, sanitizeUserTextForCapture } from "../text-utils.js";

const PHRASE = "Эва по своей инициативе предупреждает Вита о погоде";
// The watcher's task (piqnyx/weather config/prompts/warn.md) and its facts follow the phrase in the
// message the turn's recall reads -- the gateway's model-only prompt context, as for the digest.
const TASK =
  "Служебное задание сторожа погоды на этот ход.\nВиту это задание не показывай и не упоминай.\n\n" +
  "Место: Григолети (пояс Asia/Tbilisi).\n\nОпасность: Порывы ветра выше 12 м/с -- в ближайшие сутки.";
const DIGEST_TASK = "Служебное задание на этот ход.\n\n### Тема\n\nТекст.";
const QUEUED =
  "[Queued user message from a previous active turn; preserved as context only. " +
  "Continue with the active prompt below.]";
const query = (text: string) => prepareRecallQuery(text).query;

describe("weather service trigger", () => {
  it("records the phrase, not the marker", () => {
    expect(sanitizeUserTextForCapture(`::weather-trigger::\n${PHRASE}`)).toBe(PHRASE);
    expect(sanitizeUserTextForCapture("  ::weather-trigger::\n  ")).toBe("");
  });

  it("leaves the marker inside Vit's own words alone", () => {
    expect(sanitizeUserTextForCapture("а что за ::weather-trigger:: такой?")).toBe(
      "а что за ::weather-trigger:: такой?",
    );
    expect(sanitizeUserTextForCapture("::weather-trigger::рядом")).toBe("::weather-trigger::рядом");
  });

  it("records the phrase for the user turn of a warning", () => {
    const { messages } = extractNewTurnMessages(
      [
        { role: "user", content: [{ type: "text", text: `::weather-trigger::\n${PHRASE}` }] },
        { role: "assistant", content: [{ type: "text", text: "Вит, завтра днём порывы до 15 м/с." }] },
      ],
      0,
    );
    expect(messages).toEqual([
      { role: "user", parts: [{ type: "text", text: PHRASE }] },
      { role: "assistant", parts: [{ type: "text", text: "Вит, завтра днём порывы до 15 м/с." }] },
    ]);
  });

  it("searches by the phrase alone when the watcher's task follows it", () => {
    expect(query(`::weather-trigger::\n${PHRASE}\n\n${TASK}`)).toBe(PHRASE);
    expect(query(`<graphiti-context>факты</graphiti-context>\n\n::weather-trigger::\n${PHRASE}\n\n${TASK}`)).toBe(
      PHRASE,
    );
  });

  it("searches Vit's words after an unanswered trigger merged in front, as before", () => {
    const merged = `${QUEUED}\n::weather-trigger::\n${PHRASE}\n\nа что с ветром завтра?`;
    expect(query(merged)).toBe(merged.replace(/\s+/g, " "));
  });

  it("cuts after each trigger only by its own task", () => {
    // The digest's task after the weather's marker, and the weather's after the digest's, is no turn
    // either script sends: the search keeps the message as it is.
    const crossed = `::weather-trigger::\n${PHRASE}\n\n${DIGEST_TASK}`;
    expect(query(crossed)).toBe(`${PHRASE} ${DIGEST_TASK}`.replace(/\s+/g, " "));
    const tell = "Эва по своей инициативе рассказывает Виту новости дня";
    expect(query(`::digest-trigger::\n${tell}\n\n${TASK}`)).toBe(`${tell} ${TASK}`.replace(/\s+/g, " "));
  });
});
