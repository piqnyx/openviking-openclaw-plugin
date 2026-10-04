import { describe, expect, it } from "vitest";

import { memoryOpenVikingConfigSchema } from "../config.js";

/*
 * Порог сводки -- одно число токенов, `commitTokenThreshold`. Прежняя доля от бюджета
 * (`commitTokenThresholdRatio`) не принимается: у настройки одно имя и один смысл.
 */

describe("commitTokenThreshold", () => {
  it("без ключа -- 50 000", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933" });
    expect(cfg.commitTokenThreshold).toBe(50_000);
  });

  it("принимает число и число строкой", () => {
    expect(
      memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", commitTokenThreshold: 48_000 })
        .commitTokenThreshold,
    ).toBe(48_000);
    expect(
      memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", commitTokenThreshold: "48000" })
        .commitTokenThreshold,
    ).toBe(48_000);
  });

  it("целое не меньше нуля: дробь округляется вниз, отрицательное становится нулём", () => {
    expect(
      memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", commitTokenThreshold: 12.7 })
        .commitTokenThreshold,
    ).toBe(12);
    expect(
      memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", commitTokenThreshold: -5 })
        .commitTokenThreshold,
    ).toBe(0);
  });

  it("долю от бюджета больше не принимает", () => {
    expect(() =>
      memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", commitTokenThresholdRatio: 0.2 }),
    ).toThrow(/unknown keys: commitTokenThresholdRatio/);
  });
});

/*
 * Потолок общего объёма переписки, `commitContextCeiling` (Вит, 04.10.2026): второй
 * спусковой крючок сводки, по всей переписке в оценке плагина, а не по ожидающим.
 * Без ключа потолка нет.
 */
describe("commitContextCeiling", () => {
  it("без ключа -- 0, потолка нет", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933" });
    expect(cfg.commitContextCeiling).toBe(0);
  });

  it("принимает число и число строкой", () => {
    expect(
      memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", commitContextCeiling: 248_000 })
        .commitContextCeiling,
    ).toBe(248_000);
    expect(
      memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", commitContextCeiling: "248000" })
        .commitContextCeiling,
    ).toBe(248_000);
  });

  it("целое не меньше нуля: дробь округляется вниз, отрицательное становится нулём", () => {
    expect(
      memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", commitContextCeiling: 12.7 })
        .commitContextCeiling,
    ).toBe(12);
    expect(
      memoryOpenVikingConfigSchema.parse({ baseUrl: "http://127.0.0.1:1933", commitContextCeiling: -5 })
        .commitContextCeiling,
    ).toBe(0);
  });
});
