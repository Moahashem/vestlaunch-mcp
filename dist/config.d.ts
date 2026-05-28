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
export declare function loadConfig(): Config;
//# sourceMappingURL=config.d.ts.map