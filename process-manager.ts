import type { OpenVikingClient } from "./client.js";
import { describeError } from "./error-text.js";

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// A short health request before the recall; when it fails, the reason goes into
// the text whole (timed out, refused, closed), not a bare "health check failed".
export async function quickRecallPrecheck(
  client: OpenVikingClient,
  agentId?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await client.healthCheck(500, agentId);
    return { ok: true };
  } catch (trouble) {
    return { ok: false, reason: `health check failed: ${describeError(trouble)}` };
  }
}
