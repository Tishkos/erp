/**
 * Application logging — Phase 01.1.
 *
 * 01.1 gate: *"No password, token or key appears in any application log."*
 *
 * That cannot be achieved by asking people to be careful. A password reaches a
 * log because someone logged the object that happened to contain it — a request
 * body, a caught error, a row being debugged at three in the morning. So this
 * module is the only sanctioned way to write a log line, and everything passing
 * through it is redacted by the *same* rules the audit trail uses.
 *
 * One rule set, not two: a key that is sensitive enough to withhold from the
 * permanent audit record is certainly sensitive enough to withhold from a log
 * file that ends up in a support ticket. Adding a pattern in `domain/audit.ts`
 * protects both.
 *
 * Redaction is by key name, so a secret assigned to an innocuous key still gets
 * through — `{ note: 'my password is hunter2' }` is not detected and cannot be.
 * What this closes is the ordinary case: the shaped object, logged whole.
 */
import { redact } from './domain/audit';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

function configuredLevel(): LogLevel {
  const value = process.env.LOG_LEVEL;
  return value && (LOG_LEVELS as readonly string[]).includes(value)
    ? (value as LogLevel)
    : process.env.NODE_ENV === 'production'
      ? 'info'
      : 'debug';
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly at: string;
  readonly context: Record<string, unknown>;
}

/**
 * Turns an Error into something loggable.
 *
 * The message and the stack are kept; any additional properties an error class
 * carries go through redaction, because a custom error is a plain object as far
 * as a credential is concerned — `CredentialsInvalidError` could easily be
 * given an `attemptedPassword` field by someone debugging.
 */
function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: redact(error) };

  const extra: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === 'message' || key === 'stack' || key === 'name') continue;
    extra[key] = (error as unknown as Record<string, unknown>)[key];
  }

  return {
    error: {
      name: error.name,
      message: error.message,
      // The stack is a code path, not data — but it is truncated, because a
      // full stack in every line makes a log unreadable and unsearchable.
      stack: error.stack?.split('\n').slice(0, 8).join('\n') ?? null,
      ...(Object.keys(extra).length > 0 ? { detail: redact(extra) } : {}),
    },
    ...(error.cause ? { cause: describeError(error.cause) } : {}),
  };
}

/** Builds the record without writing it — the shape the tests assert on. */
export function buildLogRecord(
  level: LogLevel,
  message: string,
  context: Record<string, unknown> = {},
  now: Date = new Date(),
): LogRecord {
  const { error, ...rest } = context;

  return {
    level,
    // The message itself is written by us and is never interpolated with a
    // value — see the note on `log` below.
    message,
    at: now.toISOString(),
    context: {
      ...(redact(rest) as Record<string, unknown>),
      ...(error !== undefined ? describeError(error) : {}),
    },
  };
}

let sink: (record: LogRecord) => void = (record) => {
  // JSON on one line: a log is read by a machine first and a person second,
  // and a multi-line entry breaks every line-oriented tool.
  const line = JSON.stringify(record);
  if (record.level === 'error' || record.level === 'warn') console.error(line);
  else console.log(line);
};

/** Redirects output — for tests, and for a hosting environment that collects. */
export function setLogSink(next: (record: LogRecord) => void): void {
  sink = next;
}

/**
 * Write a log line.
 *
 * `message` must be a constant string. Everything variable goes in `context`,
 * where it is redacted. A message built by interpolation —
 * `log('info', \`signing in \${email}:\${password}\`)` — bypasses redaction
 * entirely, which is the one failure this module cannot catch and the reason
 * the parameter is separated from the data at all.
 */
export function log(
  level: LogLevel,
  message: string,
  context: Record<string, unknown> = {},
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;
  sink(buildLogRecord(level, message, context));
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => log('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => log('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => log('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => log('error', message, context),
};
