import { describe, expect, it } from "vitest";

import { memoryOpenVikingConfigSchema } from "../config.js";

/*
 * Ключи отливания (PLAN-gorizont, 4б): X -- вес окна, при котором отливаем; K -- вес самых
 * новых сообщений, которые остаются; планка -- меньше стольких сообщений не остаётся никогда.
 */

const BASE = { baseUrl: "http://127.0.0.1:1933" };

describe("ключи отливания", () => {
  it("умолчания: X 245 000, K 150 000, планка 20", () => {
    const cfg = memoryOpenVikingConfigSchema.parse(BASE);
    expect(cfg.pourOffAtTokens).toBe(245_000);
    expect(cfg.keepRecentTokens).toBe(150_000);
    expect(cfg.keepRecentFloor).toBe(20);
  });

  it("числа и числа строкой, целые, не меньше единицы; планка не меньше нуля", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      ...BASE, pourOffAtTokens: "200000", keepRecentTokens: 120_000.9, keepRecentFloor: "0",
    });
    expect(cfg.pourOffAtTokens).toBe(200_000);
    expect(cfg.keepRecentTokens).toBe(120_000);
    expect(cfg.keepRecentFloor).toBe(0);
    expect(memoryOpenVikingConfigSchema.parse({ ...BASE, pourOffAtTokens: -5 }).pourOffAtTokens).toBe(1);
    expect(memoryOpenVikingConfigSchema.parse({ ...BASE, keepRecentTokens: 0 }).keepRecentTokens).toBe(1);
    expect(memoryOpenVikingConfigSchema.parse({ ...BASE, keepRecentFloor: -3 }).keepRecentFloor).toBe(0);
  });
});
