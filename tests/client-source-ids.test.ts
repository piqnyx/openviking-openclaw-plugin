import { describe, expect, it } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, OpenVikingRequestError } from "../client.js";

/*
 * PLAN-krug Р1, шаг 7б: сообщение пишется с номерами строк шлюза, из которых оно собрано
 * (`source_message_ids` -- сервер 0.4.12 принимает их при записи и отдаёт в сообщениях остатка),
 * чтобы «догнать» знало, какие строки Викинг уже держит. Без номеров тело записи -- прежнее.
 */

function client(transport: HttpTransport): OpenVikingClient {
  return new OpenVikingClient("http://127.0.0.1:1933", "ov-key", "main", 5_000, "", "", undefined, {
    transport,
  });
}

function capturing(): { transport: HttpTransport; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const transport: HttpTransport = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "ok", result: { session_id: "s1" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { transport, bodies };
}

describe("запись сообщения с номерами строк", () => {
  it("кладёт номера строк в тело записи", async () => {
    const { transport, bodies } = capturing();

    await client(transport).addSessionMessage(
      "s1",
      "assistant",
      [{ type: "text", text: "ответ" }],
      undefined,
      "2026-11-09T10:00:01.000Z",
      undefined,
      ["r1", "r2"],
    );

    expect(bodies).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", text: "ответ" }],
        created_at: "2026-11-09T10:00:01.000Z",
        source_message_ids: ["r1", "r2"],
      },
    ]);
  });

  it("без номеров пишет прежнее тело", async () => {
    const { transport, bodies } = capturing();

    await client(transport).addSessionMessage("s1", "user", [{ type: "text", text: "вопрос" }]);

    expect(bodies).toEqual([{ role: "user", parts: [{ type: "text", text: "вопрос" }] }]);
  });
});

describe("отказ сервера несёт число ответа и код", () => {
  it("ошибка записи знает HTTP-ответ и код сервера, текст прежний", async () => {
    const transport: HttpTransport = async () =>
      new Response(
        JSON.stringify({ status: "error", error: { code: "INVALID_ARGUMENT", message: "parts must not be empty" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );

    const failure = await client(transport)
      .addSessionMessage("s1", "user", [])
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(OpenVikingRequestError);
    expect(failure).toMatchObject({ status: 400, code: "INVALID_ARGUMENT" });
    expect((failure as Error).message).toBe("OpenViking request failed [INVALID_ARGUMENT]: parts must not be empty");
  });
});
