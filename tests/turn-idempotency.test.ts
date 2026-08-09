import { describe, expect, it } from "vitest";

import { claimTurn, turnFingerprint } from "../context-engine.js";

const msgs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ role: "user", content: `m${i}` }));

describe("отпечаток хода", () => {
  it("одинаков для afterTurn и commitTurn на одном ходу", () => {
    // Оба пути получают от хоста одни и те же messages и prePromptMessageCount.
    expect(turnFingerprint("s1", 4, msgs(6))).toBe(turnFingerprint("s1", 4, msgs(6)));
  });

  it("различается, когда ход другой", () => {
    expect(turnFingerprint("s1", 4, msgs(6))).not.toBe(turnFingerprint("s1", 6, msgs(8)));
  });

  it("различается между сессиями", () => {
    expect(turnFingerprint("s1", 4, msgs(6))).not.toBe(turnFingerprint("s2", 4, msgs(6)));
  });
});

describe("защита от повторного захвата", () => {
  it("отдаёт ход только один раз", () => {
    const key = turnFingerprint("sess-a", 0, msgs(2));
    expect(claimTurn("sess-a", key)).toBe(true);
    // Второй путь на том же ходу должен получить отказ и ничего не записать.
    expect(claimTurn("sess-a", key)).toBe(false);
  });

  it("повтор commitTurn с тем же advancementKey не проходит", () => {
    expect(claimTurn("sess-b", "key:adv-1")).toBe(true);
    expect(claimTurn("sess-b", "key:adv-1")).toBe(false);
    expect(claimTurn("sess-b", "key:adv-2")).toBe(true);
  });

  it("сессии не мешают друг другу", () => {
    const key = turnFingerprint("x", 0, msgs(1));
    expect(claimTurn("sess-c", key)).toBe(true);
    expect(claimTurn("sess-d", key)).toBe(true);
  });
});
