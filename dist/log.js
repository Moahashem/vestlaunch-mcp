/**
 * Tiny stderr logger. The MCP stdio transport owns stdout for protocol
 * messages, so all human-readable logging MUST go to stderr.
 */
const LEVEL_RANK = {
    silent: -1,
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};
let currentLevel = "info";
export function setLogLevel(level) {
    currentLevel = level;
}
function shouldLog(level) {
    return LEVEL_RANK[level] <= LEVEL_RANK[currentLevel];
}
function emit(level, msg, extra) {
    if (!shouldLog(level))
        return;
    const ts = new Date().toISOString();
    const prefix = `[vestlaunch-mcp ${ts} ${level}]`;
    if (extra === undefined) {
        process.stderr.write(`${prefix} ${msg}\n`);
    }
    else {
        process.stderr.write(`${prefix} ${msg} ${JSON.stringify(extra)}\n`);
    }
}
export const log = {
    error: (msg, extra) => emit("error", msg, extra),
    warn: (msg, extra) => emit("warn", msg, extra),
    info: (msg, extra) => emit("info", msg, extra),
    debug: (msg, extra) => emit("debug", msg, extra),
};
//# sourceMappingURL=log.js.map