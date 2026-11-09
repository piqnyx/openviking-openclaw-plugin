import { describe, expect, it } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient } from "../client.js";

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
