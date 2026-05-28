/**
 * Tiny stderr logger. The MCP stdio transport owns stdout for protocol
 * messages, so all human-readable logging MUST go to stderr.
 */
import type { LogLevel } from "./config.js";
export declare function setLogLevel(level: LogLevel): void;
export declare const log: {
    error: (msg: string, extra?: unknown) => void;
    warn: (msg: string, extra?: unknown) => void;
    info: (msg: string, extra?: unknown) => void;
    debug: (msg: string, extra?: unknown) => void;
};
//# sourceMappingURL=log.d.ts.map