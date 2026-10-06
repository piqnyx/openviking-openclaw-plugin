import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import type { OVMessage } from "../client.js";
import { PriceHandle, priceBodyOf } from "../price-handle.js";

/*
 * Ручка цены прокси (PLAN-gorizont, 4а).
 *
 * Прокси считает вес запроса ровно так, как его спишет Гугл, и ручка `POST /price` даёт то же
 * число без отправки. Плагин шлёт ей тело в форме OpenAI (model, messages; вызовы инструментов
 * как tool_calls, ответы ролью tool) -- ту же форму, что шлёт сервер Викинга, -- и берёт ответ
 * как есть. Ручка молчит, отвечает не 200, не JSON или без вердикта -- вердикта нет, в журнал
 * предупреждение; решать дальше -- тому, кто спрашивал.
 *
 * Тело обязано кончаться сообщением пользователя: ворота прокси отвергают тело, кончающееся
 * ходом модели (проверено 07.10 на gatekeeper.validate). Поэтому к хвосту добавляется «x», как
 * в замерах 1г; цена его -- около одного.
 */

type Answer = { status: number; body: unknown; raw?: string };

function handle(answer: Answer | (() => Promise<Response>), timeoutMs = 5_000) {
  const posted: Array<{ url: string; body: unknown; contentType: string | null }> = [];
  const warned: string[] = [];
  const transport: HttpTransport = vi.fn(async (url, init) => {
    const headers = new Headers(init.headers ?? {});
    posted.push({
      url,
      body: init.body ? JSON.parse(String(init.body)) : null,
      contentType: headers.get("Content-Type"),
    });
    if (typeof answer === "function") {
      return answer();
    }
    return new Response(answer.raw ?? JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  const price = new PriceHandle("http://127.0.0.1:8787/price", {
    transport,
    timeoutMs,
    logger: { info: () => {}, warn: (line) => warned.push(line) },
  });
  return { price, posted, warned };
}

const VERDICT = {
  model: "gemini-3.5-flash-lite",
  charge: 187_913,
  ours: 187_913,
  google: 175_290,
  surcharge: 0,
  input_zeroed: false,
  ceiling: 249_000,
  google_ceiling: 250_000,
  fits: true,
  counted_on: 7,
};

describe("ручка цены", () => {
  it("шлёт тело как JSON по адресу и отдаёт вердикт как есть", async () => {
    const { price, posted } = handle({ status: 200, body: VERDICT });
    const body = { model: "gemini-3.5-flash-lite", messages: [{ role: "user", content: "x" }] };

    const verdict = await price.price(body);

    expect(verdict).toEqual(VERDICT);
    expect(posted).toEqual([
      { url: "http://127.0.0.1:8787/price", body, contentType: "application/json" },
    ]);
  });

  it("ручка молчит -- вердикта нет, предупреждение", async () => {
    const { price, warned } = handle(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await price.price({ model: "m", messages: [] })).toBeNull();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("http://127.0.0.1:8787/price");
    expect(warned[0]).toContain("fetch failed");
  });

  it("ручка не отвечает в срок -- вердикта нет", async () => {
    const { price, warned } = handle(
      () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new DOMException("The operation was aborted.", "AbortError")), 50);
        }),
      10,
    );
    expect(await price.price({ model: "m", messages: [] })).toBeNull();
    expect(warned[0]).toMatch(/aborted|no answer/i);
  });

  it("не 200 -- вердикта нет, в предупреждении код и слова ответа", async () => {
    const { price, warned } = handle({
      status: 400,
      body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "Proxy: the body names no model" } },
    });
    expect(await price.price({ messages: [] })).toBeNull();
    expect(warned[0]).toContain("400");
    expect(warned[0]).toContain("names no model");
  });

  it("не JSON или без вердикта -- вердикта нет", async () => {
    const notJson = handle({ status: 200, body: null, raw: "<html>gateway</html>" });
    expect(await notJson.price.price({ model: "m", messages: [] })).toBeNull();
    expect(notJson.warned[0]).toMatch(/JSON/);

    const noVerdict = handle({ status: 200, body: { charge: 5 } });
    expect(await noVerdict.price.price({ model: "m", messages: [] })).toBeNull();
    expect(noVerdict.warned[0]).toMatch(/verdict/);
  });
});

function ov(id: string, role: string, parts: OVMessage["parts"]): OVMessage {
  return { id, role, parts, created_at: "2026-10-07T00:00:00Z" };
}

describe("тело для ручки", () => {
  it("сообщения сервера в форме OpenAI: текст, вызов инструмента, ответ инструмента, и «x» в конце", () => {
    const messages = [
      ov("u1", "user", [{ type: "text", text: "прочитай файл" }]),
      ov("a1", "assistant", [
        {
          type: "tool",
          tool_id: "call_7",
          tool_name: "read",
          tool_input: { path: "a.txt" },
          tool_output: "содержимое",
          tool_status: "completed",
        },
      ]),
      ov("a2", "assistant", [{ type: "text", text: "в файле написано содержимое" }]),
    ];

    const body = priceBodyOf("gemini-3.5-flash-lite", messages);

    expect(body).toEqual({
      model: "gemini-3.5-flash-lite",
      messages: [
        { role: "user", content: "прочитай файл" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_7", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } },
          ],
        },
        { role: "tool", tool_call_id: "call_7", content: "содержимое" },
        { role: "assistant", content: "в файле написано содержимое" },
        { role: "user", content: "x" },
      ],
    });
  });

  it("ответ инструмента без номера вызова идёт текстом ассистента, как в окне модели", () => {
    const messages = [
      ov("u1", "user", [{ type: "text", text: "вопрос" }]),
      ov("a1", "assistant", [
        { type: "tool", tool_name: "read", tool_output: "содержимое", tool_status: "completed" },
        { type: "text", text: "ответ" },
      ]),
    ];
    const body = priceBodyOf("m", messages);
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const assistant = body.messages[1] as { content: string | null; tool_calls?: unknown[] };
    expect(assistant.tool_calls).toBeUndefined();
    expect(assistant.content).toContain("[read] (completed)");
    expect(assistant.content).toContain("ответ");
  });

  it("пустой список -- одно «x»", () => {
    expect(priceBodyOf("m", []).messages).toEqual([{ role: "user", content: "x" }]);
  });
});
