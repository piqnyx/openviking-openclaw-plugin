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
});
