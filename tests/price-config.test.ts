import { describe, expect, it } from "vitest";

import { memoryOpenVikingConfigSchema } from "../config.js";

/*
 * Ключи ручки цены (PLAN-gorizont, 4а): адрес и срок ответа. Пустой адрес -- ручки нет.
 */

const BASE = { baseUrl: "http://127.0.0.1:1933" };

describe("ключи ручки цены", () => {
  it("без ключей -- ручка прокси на этой машине, срок минута", () => {
    const cfg = memoryOpenVikingConfigSchema.parse(BASE);
    expect(cfg.priceUrl).toBe("http://127.0.0.1:8787/price");
    expect(cfg.priceTimeoutMs).toBe(60_000);
  });

  it("адрес берётся как дан, пробелы по краям снимаются, пустой -- ручки нет", () => {
    expect(memoryOpenVikingConfigSchema.parse({ ...BASE, priceUrl: " http://10.0.0.2:8787/price " }).priceUrl)
      .toBe("http://10.0.0.2:8787/price");
    expect(memoryOpenVikingConfigSchema.parse({ ...BASE, priceUrl: "" }).priceUrl).toBe("");
    expect(memoryOpenVikingConfigSchema.parse({ ...BASE, priceUrl: "   " }).priceUrl).toBe("");
  });

  it("срок -- число или число строкой, не меньше секунды", () => {
    expect(memoryOpenVikingConfigSchema.parse({ ...BASE, priceTimeoutMs: 90_000 }).priceTimeoutMs).toBe(90_000);
    expect(memoryOpenVikingConfigSchema.parse({ ...BASE, priceTimeoutMs: "90000" }).priceTimeoutMs).toBe(90_000);
    expect(memoryOpenVikingConfigSchema.parse({ ...BASE, priceTimeoutMs: 5 }).priceTimeoutMs).toBe(1_000);
  });
});
