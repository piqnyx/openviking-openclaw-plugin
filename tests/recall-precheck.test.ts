import { describe, expect, it, vi } from "vitest";

import type { OpenVikingClient } from "../client.js";
import { quickRecallPrecheck } from "../process-manager.js";

/*
 * Проверка сервера перед подтяжкой воспоминаний (PLAN-gorizont, 5-0, замер 07.10).
 *
 * Подтяжка начинается с короткого запроса здоровья сервера, и когда он не прошёл, журнал
 * говорил только «health check failed»: не видно, сервер молчал, отказал или не уложился в
 * срок. Теперь причина уходит в текст целиком, вместе с текстом ошибки запроса.
 */

function clientWith(healthCheck: OpenVikingClient["healthCheck"]): OpenVikingClient {
  return { healthCheck } as unknown as OpenVikingClient;
}

describe("quickRecallPrecheck", () => {
  it("сервер ответил -- проверка пройдена", async () => {
    const healthCheck = vi.fn(async () => undefined);
    expect(await quickRecallPrecheck(clientWith(healthCheck), "main")).toEqual({ ok: true });
    // Five seconds (decision of 07.10): half a second lost to the gateway's own
    // stalls of two to three seconds and silently skipped the recall.
    expect(healthCheck).toHaveBeenCalledWith(5_000, "main");
  });

  it("сервер не ответил -- причина в тексте", async () => {
    const trouble = Object.assign(
      new Error("OpenViking GET /health timed out after 500 ms", {
        cause: new DOMException("This operation was aborted", "AbortError"),
      }),
      { name: "TimeoutError" },
    );
    const healthCheck = vi.fn(async () => {
      throw trouble;
    });

    expect(await quickRecallPrecheck(clientWith(healthCheck), "main")).toEqual({
      ok: false,
      reason:
        "health check failed: TimeoutError: OpenViking GET /health timed out after 500 ms " +
        "(cause: AbortError: This operation was aborted)",
    });
  });
});
