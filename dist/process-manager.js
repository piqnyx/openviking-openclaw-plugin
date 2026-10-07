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
// Five seconds (decision of 07.10): the gateway's own loop stalls for two to
// three seconds while the plugin digests the transcript, and half a second
// silently skipped the recall on such turns. A server that is down refuses at
// once, so the limit only matters for a hung server or a stalled loop.
const RECALL_HEALTH_CHECK_MS = 5_000;
// A short health request before the recall; when it fails, the reason goes into
// the text whole (timed out, refused, closed), not a bare "health check failed".
export async function quickRecallPrecheck(client, agentId) {
    try {
        await client.healthCheck(RECALL_HEALTH_CHECK_MS, agentId);
        return { ok: true };
    }
    catch (trouble) {
        return { ok: false, reason: `health check failed: ${describeError(trouble)}` };
    }
}
