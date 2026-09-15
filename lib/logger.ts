type Level = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

/**
 * Structured logging. One JSON line per event so Vercel log drains and
 * Observability can filter on userId, workspaceId and threadId.
 */
function emit(level: Level, event: string, fields: Fields = {}) {
  const line = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (event: string, fields?: Fields) => emit("debug", event, fields),
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};

/**
 * Narrows an unknown thrown value to something loggable.
 *
 * Supabase and PostgREST report failures as plain objects, not `Error`
 * instances — `{ code, message, details, hint }`. Falling through to
 * `String(error)` turns those into the literal text "[object Object]", which is
 * how a perfectly clear `42P10 — there is no unique or exclusion constraint
 * matching the ON CONFLICT specification` reached the logs as nothing at all.
 * Anything carrying a message is unwrapped before that fallback is reached.
 */
export function errorFields(error: unknown): Fields {
  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = record.message ?? record.error_description ?? record.error;

    if (typeof message === "string") {
      return {
        message,
        ...(typeof record.code === "string" ? { code: record.code } : {}),
        ...(typeof record.details === "string" ? { details: record.details } : {}),
        ...(typeof record.hint === "string" ? { hint: record.hint } : {}),
      };
    }

    // No message field: serialise rather than discard. A truncated JSON blob is
    // still a lead; "[object Object]" is not.
    try {
      return { message: JSON.stringify(error).slice(0, 500) };
    } catch {
      return { message: "unserialisable error object" };
    }
  }

  return { message: String(error) };
}
