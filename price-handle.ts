// The proxy's price handle: the weight of a request by the counter, without a send
// (gemini-proxy `POST /price`, PLAN-gorizont 1а; the plugin's side is 4а).
import { defaultHttpTransport, type HttpTransport } from "./adapters/http-transport.js";
import type { OVMessage } from "./client.js";
import { describeError } from "./error-text.js";
import {
  convertToAgentMessages,
  mergeConsecutiveAssistants,
  type AgentMessage,
} from "./services/context-message-adapter.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "./tool-call-id.js";

/** What the handle answers: the counter's verdict for the body as it is. */
export type PriceVerdict = {
  model: string;
  /** What Google will charge: the larger of the two legs plus the surcharge. */
  charge: number;
  ours: number;
  google: number | null;
  surcharge: number;
  input_zeroed?: boolean;
  /** The ceiling of any one key; `fits` is `charge <= ceiling`. */
  ceiling: number;
  google_ceiling?: number;
  fits: boolean;
  counted_on?: number | null;
};

export type PriceHandleLogger = {
  info: (message: string) => void;
  warn?: (message: string) => void;
};

const DEFAULT_PRICE_TIMEOUT_MS = 60_000;

/**
 * Asks the proxy's price handle for the weight of a body, and takes the answer as it
 * is. A handle that cannot answer -- down, not 200, no JSON, no verdict -- gives
 * nothing: the caller decides without a price, and the proxy's gate is still there
 * to refuse what is too heavy.
 */
export class PriceHandle {
  readonly url: string;
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;
  private readonly logger: PriceHandleLogger;

  constructor(
    url: string,
    options: { transport?: HttpTransport; timeoutMs?: number; logger?: PriceHandleLogger } = {},
  ) {
    this.url = url;
    this.transport = options.transport ?? defaultHttpTransport;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PRICE_TIMEOUT_MS;
    this.logger = options.logger ?? { info: () => {} };
  }

  async price(body: Record<string, unknown>): Promise<PriceVerdict | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.transport(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (trouble) {
      // Our own timer firing is a timeout; anything else is told with its causes.
      const why = controller.signal.aborted
        ? `timed out after ${this.timeoutMs} ms`
        : describeError(trouble);
      this.logger.warn?.(
        `openviking: price handle ${this.url} gave no answer (${why}); deciding without a price`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text().catch(() => "");
    if (response.status !== 200) {
      this.logger.warn?.(
        `openviking: price handle ${this.url} answered ${response.status}: ${text.slice(0, 300)}; deciding without a price`,
      );
      return null;
    }
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      this.logger.warn?.(
        `openviking: price handle ${this.url} answered no JSON (${text.slice(0, 120)}); deciding without a price`,
      );
      return null;
    }
    if (!answer || typeof answer !== "object" || !("fits" in answer)) {
      this.logger.warn?.(
        `openviking: price handle ${this.url} answered without a verdict (${text.slice(0, 120)}); deciding without a price`,
      );
      return null;
    }
    return answer as PriceVerdict;
  }
}

export type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAiMessage =
  | { role: "user" | "system"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const b = block as Record<string, unknown>;
      return b.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function argumentsOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

/**
 * The messages of the model's window in the form the proxy's counter reads:
 * OpenAI's `messages`, tool calls as `tool_calls`, tool answers with the role
 * `tool`. The same form the Viking server sends the handle (PIQNYX.md, stage 4).
 */
export function toOpenAiMessages(messages: AgentMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  for (const message of messages) {
    const m = message as unknown as Record<string, unknown>;
    const role = String(m.role ?? "");
    if (role === "toolResult") {
      out.push({
        role: "tool",
        tool_call_id: typeof m.toolCallId === "string" ? m.toolCallId : "",
        content: textOf(m.content),
      });
      continue;
    }
    if (role === "assistant") {
      const calls: OpenAiToolCall[] = [];
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (!block || typeof block !== "object") {
            continue;
          }
          const b = block as Record<string, unknown>;
          if (b.type === "toolCall" && typeof b.id === "string") {
            calls.push({
              id: b.id,
              type: "function",
              function: { name: String(b.name ?? "unknown"), arguments: argumentsOf(b.arguments) },
            });
          }
        }
      }
      const text = textOf(m.content);
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }
    out.push({ role: role === "system" ? "system" : "user", content: textOf(m.content) });
  }
  return out;
}

/**
 * The body the handle is asked about for a tail of the server's messages: rendered
 * the way the window is assembled from them, in OpenAI's form, with a user's «x» at
 * the end -- the proxy's gate refuses a body that ends with the model's turn
 * (checked 07.10.2026), and the measurements of 1г were taken with the same «x».
 */
export function priceBodyOf(
  model: string,
  messages: OVMessage[],
): { model: string; messages: OpenAiMessage[] } {
  const window = mergeConsecutiveAssistants(messages.flatMap((m) => convertToAgentMessages(m)));
  return { model, messages: priceMessagesOf(window) };
}

/**
 * The window's messages as the handle must see them: the tool call ids made
 * unique and strict first, the way the gateway rewrites them before a send
 * (transcript-policy: `sanitizeToolCallIds`, `toolCallIdMode: "strict"` for
 * openai-completions; the same occurrence-aware resolver copied from core in
 * tool-call-id.ts). The server keeps calls from different turns under one id,
 * and the proxy's gate refuses a body that repeats one («duplicate tool call
 * id», 400): on 09.10 that made every long tail «not fit» and the pour-off
 * kept 53 messages of 667 under K 150 000.
 */
export function priceMessagesOf(window: AgentMessage[]): OpenAiMessage[] {
  const unique = sanitizeToolCallIdsForCloudCodeAssist(
    window as unknown as Parameters<typeof sanitizeToolCallIdsForCloudCodeAssist>[0],
    "strict",
  ) as unknown as AgentMessage[];
  return [...toOpenAiMessages(unique), { role: "user", content: "x" }];
}
