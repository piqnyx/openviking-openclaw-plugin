import { describeError } from "./error-text.js";
export function withTimeout(promise, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
// A short health request before the recall; when it fails, the reason goes into
// the text whole (timed out, refused, closed), not a bare "health check failed".
export async function quickRecallPrecheck(client, agentId) {
    try {
        await client.healthCheck(500, agentId);
        return { ok: true };
    }
    catch (trouble) {
        return { ok: false, reason: `health check failed: ${describeError(trouble)}` };
    }
}
