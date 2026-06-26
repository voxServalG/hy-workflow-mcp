export type LogLevel = "info" | "warn" | "error" | "debug";

const PREFIX: Record<LogLevel, string> = {
  info: "[INFO]",
  warn: "[WARN]",
  error: "[ERROR]",
  debug: "[DEBUG]",
};

export function log(level: LogLevel, message: string): void {
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method](`${PREFIX[level]} ${message}`);
}

export function info(message: string): void { log("info", message); }
export function warn(message: string): void { log("warn", message); }
export function error(message: string): void { log("error", message); }
export function debug(message: string): void { log("debug", message); }

export function createLogger(context: string) {
  return {
    info: (msg: string) => log("info", `[${context}] ${msg}`),
    warn: (msg: string) => log("warn", `[${context}] ${msg}`),
    error: (msg: string) => log("error", `[${context}] ${msg}`),
    debug: (msg: string) => log("debug", `[${context}] ${msg}`),
  };
}
