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

function client(
  transport: HttpTransport,
  timeoutMs = 5_000,
  warn?: (message: string) => void,
): OpenVikingClient {
  return new OpenVikingClient(
    "http://127.0.0.1:1933",
    "ov-key",
    "main",
    timeoutMs,
    "",
    "",
    undefined,
    { transport, ...(warn ? { warn } : {}) },
  );
}

function droppedByPeer(): TypeError {
  const socket = Object.assign(new Error("other side closed"), {
    name: "SocketError",
    code: "UND_ERR_SOCKET",
  });
  return new TypeError("fetch failed", { cause: socket });
}

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ status: "ok", result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

  /*
   * Повтор чтения (PLAN-gorizont 5-0, решение Вита 07.10): сервер закрывает отлежавшееся
   * соединение, плагин этого не замечает и пишет в закрытое -- «other side closed». Чтение
   * повторяется один раз по новому соединению; второе падение уходит наверх с причиной.
   * Запись не повторяется: повтор мог бы продублировать сообщение. Отказ в соединении
   * (сервер лежит) и свой истёкший срок не повторяются.
   */
  it("чтение после закрытого сервером соединения повторяется один раз, с предупреждением", async () => {
    const warned: string[] = [];
    let calls = 0;
    const c = client(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw droppedByPeer();
        }
        return okResponse({ messages: [] });
      },
      5_000,
      (line) => warned.push(line),
    );

    await expect(c.getSessionContext("s1", 1_000)).resolves.toEqual({ messages: [] });

    expect(calls).toBe(2);
    expect(warned).toEqual([
      "openviking: GET /api/v1/sessions/s1/context?token_budget=1000 retried once after " +
        "fetch failed (cause: SocketError: other side closed [UND_ERR_SOCKET])",
    ]);
  });

  it("второе падение чтения уходит наверх с причиной", async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      throw droppedByPeer();
    });

    const err = await rejection(c.getSessionContext("s1", 1_000));

    expect(calls).toBe(2);
    expect(err.message).toBe(
      "OpenViking GET /api/v1/sessions/s1/context?token_budget=1000: " +
        "fetch failed (cause: SocketError: other side closed [UND_ERR_SOCKET])",
    );
  });

  it("сброшенное соединение тоже повторяется", async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        });
      }
      return okResponse({ status: "ok" });
    });

    await expect(c.healthCheck()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("запись не повторяется", async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      throw droppedByPeer();
    });

    const err = await rejection(c.addSessionMessage("s1", "user", [{ type: "text", text: "hi" }]));

    expect(calls).toBe(1);
    expect(err.message).toContain("POST /api/v1/sessions/s1/messages: fetch failed");
  });

  it("отказ в соединении не повторяется", async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1933"), {
          code: "ECONNREFUSED",
        }),
      });
    });

    const err = await rejection(c.getSessionContext("s1", 1_000));

    expect(calls).toBe(1);
    expect(err.message).toContain("[ECONNREFUSED]");
  });

  it("истёкший срок не повторяется", async () => {
    let calls = 0;
    const c = client(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          calls += 1;
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")),
          );
        }),
      5,
    );

    const err = await rejection(c.healthCheck());

    expect(calls).toBe(1);
    expect(err.name).toBe("TimeoutError");
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
