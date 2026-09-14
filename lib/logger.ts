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

/** Narrows an unknown thrown value to something loggable. */
export function errorFields(error: unknown): Fields {
  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }
  return { message: String(error) };
}
