/** A message timestamp as the server takes it: numbers below 1e11 are seconds. */
export function normalizeTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        const timestampMs = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
        return new Date(timestampMs).toISOString();
    }
    return undefined;
}
function isToolOnlyMessage(msg) {
    return msg.role === "assistant" && msg.parts.length > 0 && msg.parts.every((part) => part.type === "tool");
}
/**
 * Consecutive tool results of one round as one message; an empty message (a round's start) only
 * separates rounds. Each message keeps the indexes of the transcript rows it was made of.
 */
export function coalesceConsecutiveToolMessages(messages) {
    const result = [];
    let pendingTools;
    const flush = () => {
        if (pendingTools) {
            result.push(pendingTools);
            pendingTools = undefined;
        }
    };
    for (const msg of messages) {
        if (isToolOnlyMessage(msg)) {
            if (!pendingTools) {
                pendingTools = { role: "assistant", parts: [], rows: [] };
            }
            pendingTools.parts.push(...msg.parts);
            pendingTools.rows.push(...msg.rows);
            continue;
        }
        flush();
        // An empty message is the start of a round of tool results (a tool call without
        // text, text-utils): a boundary only, nothing to keep.
        if (msg.parts.length === 0) {
            continue;
        }
        result.push(msg);
    }
    flush();
    return result;
}
/** The parts of one extracted message as the server stores them. */
export function toOvParts(msg) {
    return msg.parts.map((part) => {
        if (part.type === "text") {
            const cleaned = part.text
                .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/gi, " ")
                .replace(/\s+/g, " ")
                .trim();
            return { type: "text", text: cleaned };
        }
        return {
            type: "tool",
            tool_id: part.toolCallId,
            tool_name: part.toolName,
            tool_input: part.toolInput,
            tool_output: part.toolOutput,
            tool_status: part.toolStatus,
        };
    });
}
