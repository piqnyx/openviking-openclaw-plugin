import { describe, expect, it } from "vitest";

import { longestTailWithin, turnStarts } from "../tail-by-weight.js";
import type { AgentMessage } from "../services/context-message-adapter.js";

/*
 * Резак хвоста по весу (PLAN-gorizont, 4б).
 *
 * Хвост окна, который остаётся модели, кончается там же, где окно, и начинается на границе
 * хода -- с сообщения пользователя: вызов инструмента не отрывается от ответа. Из годных
 * хвостов (не короче планки) берётся самый длинный, чей вес по ручке не больше cap; вес
 * растёт с длиной, поэтому его ищут двоичным поиском -- около log2(границ) обращений к ручке.
 * Самый короткий годный хвост тяжелее cap -- берётся он: планка сильнее веса. Годных нет --
 * резать нечего.
 */

function msg(role: string): AgentMessage {
  return { role, content: role === "user" ? "вопрос" : [{ type: "text", text: "ответ" }] } as AgentMessage;
}

/** Пять ходов: вопрос, (вызов и ответ инструмента), ответ. */
const FIVE_TURNS: AgentMessage[] = [
  msg("user"), msg("assistant"), msg("toolResult"), msg("assistant"),
  msg("user"), msg("assistant"),
  msg("user"), msg("assistant"), msg("toolResult"), msg("assistant"),
  msg("user"), msg("assistant"),
  msg("user"), msg("assistant"),
];

describe("границы ходов", () => {
  it("ход начинается с сообщения пользователя; ответ инструмента границей не бывает", () => {
    expect(turnStarts(FIVE_TURNS)).toEqual([0, 4, 6, 10, 12]);
  });
});

describe("самый длинный хвост не тяжелее cap", () => {
  const total = FIVE_TURNS.length;
  /** Вес хвоста с границы: по сто за сообщение. */
  const byHundreds = (start: number) => (total - start) * 100;

  it("берёт самый длинный из годных, чей вес не больше cap, и не спрашивает про каждый", async () => {
    const asked: number[] = [];
    const chosen = await longestTailWithin({
      starts: turnStarts(FIVE_TURNS),
      total,
      floor: 2,
      cap: 850,
      weigh: async (start) => {
        asked.push(start);
        return byHundreds(start);
      },
    });
    // Хвосты: с 0 -- 1400, с 4 -- 1000, с 6 -- 800, с 10 -- 400, с 12 -- 200. Не тяжелее 850 -- с 6.
    expect(chosen).toEqual({ start: 6, weight: 800, asked: asked.length });
    expect(asked.length).toBeLessThanOrEqual(3);
  });

  it("планка сильнее веса: хвосты короче планки не годятся, самый короткий годный берётся и тяжёлым", async () => {
    const chosen = await longestTailWithin({
      starts: turnStarts(FIVE_TURNS),
      total,
      floor: 5,
      cap: 100,
      weigh: async (start) => byHundreds(start),
    });
    // Годные (не короче 5 сообщений): с 0, 4, 6; самый короткий из них -- с 6, весит 800 > 100, берётся.
    expect(chosen).toMatchObject({ start: 6, weight: 800 });
  });

  it("всё окно легче cap -- хвост с самого начала", async () => {
    const chosen = await longestTailWithin({
      starts: turnStarts(FIVE_TURNS),
      total,
      floor: 2,
      cap: 10_000,
      weigh: async (start) => byHundreds(start),
    });
    expect(chosen).toMatchObject({ start: 0, weight: 1400 });
  });

  it("годных хвостов нет -- резать нечего, ручка не спрашивается", async () => {
    let asked = 0;
    const chosen = await longestTailWithin({
      starts: turnStarts(FIVE_TURNS),
      total,
      floor: 20,
      cap: 10_000,
      weigh: async () => {
        asked += 1;
        return 0;
      },
    });
    expect(chosen).toBeNull();
    expect(asked).toBe(0);
  });

  it("ручка не ответила про какой-то хвост -- этот хвост не годится, берётся тот, про который ответила", async () => {
    const chosen = await longestTailWithin({
      starts: turnStarts(FIVE_TURNS),
      total,
      floor: 2,
      cap: 10_000,
      weigh: async (start) => (start === 0 ? null : byHundreds(start)),
    });
    expect(chosen).toMatchObject({ start: 4, weight: 1000 });
  });
});
