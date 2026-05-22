/**
 * Runtime configuration loaded from environment variables.
 *
 * Each agent (Claude/Cowork, Claude Code, ClawBot, etc.) sets its own
 * VESTLAUNCH_API_KEY, so the CRM's ApiLog table can attribute every
 * tool call back to the agent that made it.
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface Config {
  baseUrl: string;
  apiKey: string;
  enableWrites: boolean;
  logLevel: LogLevel;
  timeoutMs: number;
}

const VALID_LOG_LEVELS: ReadonlyArray<LogLevel> = [
  "silent",
  "error",
  "warn",
  "info",
  "debug",
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `[vestlaunch-mcp] Missing required environment variable: ${name}. ` +
        `See .env.example for setup. Quick fix: export ${name}=...`,
    );
  }
  return value.trim();
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === "true";
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value) return "info";
  const lower = value.trim().toLowerCase() as LogLevel;
  return VALID_LOG_LEVELS.includes(lower) ? lower : "info";
}

function parseTimeout(value: string | undefined): number {
  if (!value) return 30_000;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

export function loadConfig(): Config {
  const baseUrl = requireEnv("VESTLAUNCH_BASE_URL").replace(/\/+$/, "");
  const apiKey = requireEnv("VESTLAUNCH_API_KEY");
  return {
    baseUrl,
    apiKey,
    enableWrites: parseBool(process.env.VESTLAUNCH_ENABLE_WRITES, false),
    logLevel: parseLogLevel(process.env.VESTLAUNCH_LOG_LEVEL),
    timeoutMs: parseTimeout(process.env.VESTLAUNCH_TIMEOUT_MS),
  };
}
