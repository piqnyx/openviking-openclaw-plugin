import { describe, expect, it } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient } from "../client.js";

/*
 * Ошибки запросов клиента к серверу Викинга (PLAN-gorizont, 5-0, замер 07.10).
 *
 * Три чтения окна упали с голым `TypeError: fetch failed`, и по журналу нельзя было сказать,
 * что случилось с соединением. Теперь клиент, когда транспорт не дал ответа, бросает ошибку,
 * которая называет запрос (метод и путь), несёт текст причины до самого дна и хранит исходную
 * ошибку в `cause`; имя исходной ошибки сохраняется, чтобы те, кто различает ошибки по имени,
 * видели то же, что раньше. Срок ожидания, истёкший по нашему таймеру, называется сроком с
 * числом миллисекунд, а не «operation was aborted». Ответ сервера с ошибкой (HTTP не 200 или
 * status error) идёт прежней дорогой и не заворачивается второй раз.
 */

function client(transport: HttpTransport, timeoutMs = 5_000): OpenVikingClient {
  return new OpenVikingClient(
    "http://127.0.0.1:1933",
    "ov-key",
    "main",
    timeoutMs,
    "",
    "",
    undefined,
    { transport },
  );
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a rejection");
}

describe("ошибки запросов клиента", () => {
  it("сетевая ошибка называет запрос и причину, хранит исходную ошибку и её имя", async () => {
    const socket = Object.assign(new Error("other side closed"), {
      name: "SocketError",
      code: "UND_ERR_SOCKET",
    });
    const fetchFailed = new TypeError("fetch failed", { cause: socket });
    const c = client(async () => {
      throw fetchFailed;
    });

    const err = await rejection(c.getSessionContext("s1", 1_000));

    expect(err.message).toBe(
      "OpenViking GET /api/v1/sessions/s1/context?token_budget=1000: " +
        "fetch failed (cause: SocketError: other side closed [UND_ERR_SOCKET])",
    );
    expect(err.name).toBe("TypeError");
    expect(err.cause).toBe(fetchFailed);
  });

  it("истёкший срок называется сроком с числом миллисекунд", async () => {
    const c = client(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")),
          );
        }),
      5,
    );

    const err = await rejection(c.healthCheck());

    expect(err.message).toBe("OpenViking GET /health timed out after 5 ms");
    expect(err.name).toBe("TimeoutError");
    expect((err.cause as Error).name).toBe("AbortError");
  });

  it("срок запроса, заданный вызовом, попадает в текст", async () => {
    const c = client(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")),
          );
        }),
      5_000,
    );

    const err = await rejection(c.healthCheck(7));

    expect(err.message).toBe("OpenViking GET /health timed out after 7 ms");
  });

  it("ответ сервера с ошибкой идёт прежней дорогой", async () => {
    const c = client(
      async () =>
        new Response(JSON.stringify({ status: "error", error: { code: "NOT_FOUND", message: "no such session" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const err = await rejection(c.getSessionContext("s1", 1_000));

    expect(err.message).toBe("OpenViking request failed [NOT_FOUND]: no such session");
    expect(err.cause).toBeUndefined();
  });

  it("запрос с телом называет свой метод", async () => {
    const c = client(async () => {
      throw new TypeError("fetch failed");
    });

    const err = await rejection(c.addSessionMessage("s1", "user", [{ type: "text", text: "hi" }]));

    expect(err.message).toBe("OpenViking POST /api/v1/sessions/s1/messages: fetch failed");
    expect(err.name).toBe("TypeError");
  });
});
