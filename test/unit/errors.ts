import { ERROR_SUBTYPES, ERROR_TYPES } from "../../src/errors/catalog.js";
import { errorMessage, structuredError } from "../../src/errors/structured.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const requiredTypes = ["validation", "workflow_state", "scope", "docs", "verification", "config", "io", "internal"];
for (const type of requiredTypes) assert((ERROR_TYPES as readonly string[]).includes(type), "missing error type " + type);
assert(ERROR_SUBTYPES.includes("contract_failed"), "missing contract_failed subtype");

const fromString = structuredError("Phase edit is not allowed");
assert(fromString.type === "workflow_state", "string errors should be classified");
assert(fromString.subtype === "invalid_phase", "phase string should map to invalid_phase");
assert(errorMessage(fromString).includes("Phase edit"), "errorMessage should expose message");

const legacy = structuredError({ type: "setup_update_required", status: "missing_stamp" });
assert(legacy.type === "config", "legacy setup type should map to config");
assert(legacy.subtype === "setup_update_required", "legacy setup type should become subtype");

