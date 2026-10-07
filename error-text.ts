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

function causesOf(error: Error): unknown[] {
  const parts = (error as { errors?: unknown }).errors;
  if (Array.isArray(parts) && parts.length > 0) {
    return parts;
  }
  return error.cause === undefined ? [] : [error.cause];
}

function describeAt(trouble: unknown, depth: number): string {
  if (!(trouble instanceof Error)) {
    return String(trouble);
  }
  return `${trouble.name}${trouble.message ? `: ${trouble.message}` : ""}${suffixAt(trouble, depth)}`;
}

function suffixAt(error: Error, depth: number): string {
  const code = (error as { code?: unknown }).code;
  const codeText = typeof code === "string" && code ? ` [${code}]` : "";
  const causes = causesOf(error);
  if (causes.length === 0 || depth >= MAX_DEPTH) {
    return codeText;
  }
  return `${codeText} (cause: ${causes.map((cause) => describeAt(cause, depth + 1)).join("; ")})`;
}

/** Name, message, code and the causes underneath: `TypeError: fetch failed (cause: ...)`. */
export function describeError(trouble: unknown): string {
  return describeAt(trouble, 0);
}

/** Only what follows the message: the code and the causes, for a text that names the error itself. */
export function causeSuffix(error: Error): string {
  return suffixAt(error, 0);
}
