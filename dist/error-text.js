/**
 * Text of an error for the log, causes included.
 *
 * A network failure of fetch in Node is a bare `TypeError: fetch failed`; what
 * actually happened to the connection (the other side closed it, the connect was
 * refused, an undici code) sits in `cause`, and `String(err)` never shows it.
 * The chain is unfolded here: name, message, a code in brackets when there is
 * one, nested causes after "cause", the parts of an AggregateError side by side.
 * The depth is capped so a ring of causes cannot loop.
 */
const MAX_DEPTH = 3;
function causesOf(error) {
    const parts = error.errors;
    if (Array.isArray(parts) && parts.length > 0) {
        return parts;
    }
    return error.cause === undefined ? [] : [error.cause];
}
function describeAt(trouble, depth) {
    if (!(trouble instanceof Error)) {
        return String(trouble);
    }
    return `${trouble.name}${trouble.message ? `: ${trouble.message}` : ""}${suffixAt(trouble, depth)}`;
}
function suffixAt(error, depth) {
    const code = error.code;
    const codeText = typeof code === "string" && code ? ` [${code}]` : "";
    const causes = causesOf(error);
    if (causes.length === 0 || depth >= MAX_DEPTH) {
        return codeText;
    }
    return `${codeText} (cause: ${causes.map((cause) => describeAt(cause, depth + 1)).join("; ")})`;
}
/** Name, message, code and the causes underneath: `TypeError: fetch failed (cause: ...)`. */
export function describeError(trouble) {
    return describeAt(trouble, 0);
}
/** Only what follows the message: the code and the causes, for a text that names the error itself. */
export function causeSuffix(error) {
    return suffixAt(error, 0);
}
const DROPPED_CODES = new Set(["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"]);
const DROPPED_MESSAGE_RE = /other side closed|socket hang up/i;
function droppedAt(trouble, depth) {
    if (!(trouble instanceof Error)) {
        return false;
    }
    const code = trouble.code;
    if ((typeof code === "string" && DROPPED_CODES.has(code)) || DROPPED_MESSAGE_RE.test(trouble.message)) {
        return true;
    }
    if (depth >= MAX_DEPTH) {
        return false;
    }
    return causesOf(trouble).some((cause) => droppedAt(cause, depth + 1));
}
/**
 * The connection was closed or reset under us while the request was in flight,
 * anywhere down the cause chain: a keep-alive socket the server dropped while
 * idle, a reset, a broken pipe. A refused connection (the server is down), our
 * own timeout and the server's answers are not that.
 */
export function isConnectionDropped(trouble) {
    return droppedAt(trouble, 0);
}
