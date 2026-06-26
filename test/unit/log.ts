import { log, info, warn, error, debug, createLogger } from "../../src/log/index.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// Basic log level output
log("info", "test message"); // smoke test only

// Shorthand functions should not throw
info("info test");
warn("warn test");
error("error test");
debug("debug test");

// Contextual logger
const ctx = createLogger("test-module");
ctx.info("contextual test");

assert(true, "log module should not throw");
