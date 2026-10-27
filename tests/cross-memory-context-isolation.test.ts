import { describe, expect, it } from "vitest";

import {
  sanitizeUserTextForCapture,
  stripOpenVikingContextInjection,
} from "../text-utils.js";

describe("cross-memory context isolation", () => {
  it("removes Graphiti recall blocks before OpenViking capture", () => {
    const input =
      "real user text <graphiti-context>Relevant Graphiti facts: secret</graphiti-context> tail";
    expect(sanitizeUserTextForCapture(input)).toBe("real user text tail");
  });

  it("strips both OpenViking and Graphiti injected memory blocks", () => {
    const input = [
      "before",
      "<openviking-context>viking memory</openviking-context>",
      "<relevant-memories>legacy memory</relevant-memories>",
      "<graphiti-context>graphiti memory</graphiti-context>",
      "after",
    ].join(" ");

    expect(stripOpenVikingContextInjection(input)).toBe("before after");
  });

  // Live 27.10: a photo steered into a running turn reached capture with the gateway's number block
  // on top (every injected context header carries ⟦openclaw:ctx⟧), the attachment path and the hint
  // telling the model how to send a picture back. The description is the picture's memory and the
  // person's words are theirs: both stay.
  it("keeps a picture's description and the person's words, drops the gateway's notes for the model", () => {
    const steered = [
      "Conversation info: ⟦openclaw:ctx⟧",
      "```json",
      '{"chat_id":"telegram:8248439450","message_id":"7723","sender":{"name":"Viktor","username":"ppkeen"}}',
      "```",
      "",
      "[media attached: media/inbound/2f1c-adc8.jpg (image)]",
      "To send an image back, use the message tool with structured media fields such as media, mediaUrl, path, or filePath. Keep caption in the text body.",
      "[Image]",
      "User text:",
      "тест подмешивания с картинкой",
      "Description:",
      "Паб: на сцене рыжая девушка в кожаной куртке поёт в микрофон, на стенах вывески Löwenbräu и Bitburger.",
    ].join("\n");

    expect(sanitizeUserTextForCapture(steered)).toBe(
      "[Image] User text: тест подмешивания с картинкой Description: Паб: на сцене рыжая девушка в кожаной куртке поёт в микрофон, на стенах вывески Löwenbräu и Bitburger.",
    );
    // Any marked block goes, whatever its label; an album's attachment header too.
    expect(
      sanitizeUserTextForCapture(
        'Replied message: ⟦openclaw:ctx⟧\n```json\n{"body":"старое"}\n```\n[media attached: 2 files]\n[media attached 1/2: media/inbound/a.jpg (image)]\nвот альбом',
      ),
    ).toBe("вот альбом");
    // The person's own words that only look alike stay.
    expect(
      sanitizeUserTextForCapture("Я пишу [media attached: тут] прямо в строке и To send an image back смешно"),
    ).toBe("Я пишу [media attached: тут] прямо в строке и To send an image back смешно");
  });
});
