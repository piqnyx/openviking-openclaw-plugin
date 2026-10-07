import { describe, expect, it } from "vitest";

import { describeError } from "../error-text.js";

/*
 * Текст ошибки для журнала (PLAN-gorizont, 5-0, замер 07.10).
 *
 * Сетевая ошибка fetch в Node приходит как `TypeError: fetch failed`, а настоящая причина
 * (сокет закрыт другой стороной, соединение отвергнуто, код undici) лежит в `cause`. Журнал
 * печатал только верхушку, и три падения чтения окна остались без объяснения. Помощник
 * разворачивает цепочку причин: имя, текст, код в скобках, вложенные причины через «cause»,
 * составная ошибка перечисляет свои части, глубина ограничена, не-ошибки печатаются как есть.
 */

function withCode(error: Error, code: string): Error {
  return Object.assign(error, { code });
}

describe("describeError", () => {
  it("печатает имя и текст простой ошибки", () => {
    expect(describeError(new Error("plain"))).toBe("Error: plain");
  });

  it("добавляет код, когда он есть", () => {
    const refused = withCode(new Error("connect ECONNREFUSED 127.0.0.1:1933"), "ECONNREFUSED");
    expect(describeError(refused)).toBe(
      "Error: connect ECONNREFUSED 127.0.0.1:1933 [ECONNREFUSED]",
    );
  });

  it("разворачивает причину сетевой ошибки fetch", () => {
    const socket = withCode(new Error("other side closed"), "UND_ERR_SOCKET");
    socket.name = "SocketError";
    const fetchFailed = new TypeError("fetch failed", { cause: socket });

    expect(describeError(fetchFailed)).toBe(
      "TypeError: fetch failed (cause: SocketError: other side closed [UND_ERR_SOCKET])",
    );
  });

  it("составная ошибка перечисляет свои части", () => {
    const v6 = withCode(new Error("connect ECONNREFUSED ::1:1933"), "ECONNREFUSED");
    const v4 = withCode(new Error("connect ECONNREFUSED 127.0.0.1:1933"), "ECONNREFUSED");
    const fetchFailed = new TypeError("fetch failed", { cause: new AggregateError([v6, v4]) });

    expect(describeError(fetchFailed)).toBe(
      "TypeError: fetch failed (cause: AggregateError (cause: " +
        "Error: connect ECONNREFUSED ::1:1933 [ECONNREFUSED]; " +
        "Error: connect ECONNREFUSED 127.0.0.1:1933 [ECONNREFUSED]))",
    );
  });

  it("причина не-ошибка печатается как есть", () => {
    expect(describeError(new Error("outer", { cause: "just a string" }))).toBe(
      "Error: outer (cause: just a string)",
    );
  });

  it("не-ошибка печатается как есть", () => {
    expect(describeError("plain string")).toBe("plain string");
    expect(describeError(42)).toBe("42");
  });

  it("глубина цепочки ограничена, кольцо не зацикливает", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    Object.assign(a, { cause: b });

    const text = describeError(b);
    expect(text.startsWith("Error: b (cause: Error: a (cause: Error: b")).toBe(true);
    expect(text.length).toBeLessThan(200);
  });
});
