/**
 * Tiny stderr logger. The MCP stdio transport owns stdout for protocol
 * messages, so all human-readable logging MUST go to stderr.
 */

import type { LogLevel } from "./config.js";

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[currentLevel];
}

function emit(level: Exclude<LogLevel, "silent">, msg: string, extra?: unknown): void {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const prefix = `[vestlaunch-mcp ${ts} ${level}]`;
  if (extra === undefined) {
    process.stderr.write(`${prefix} ${msg}\n`);
  } else {
    process.stderr.write(`${prefix} ${msg} ${JSON.stringify(extra)}\n`);
  }
}

export const log = {
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
};
