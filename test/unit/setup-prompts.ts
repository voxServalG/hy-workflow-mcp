import { parseSetupArgs, setupHelp } from "../../src/setup-cli.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const parsed = parseSetupArgs(["--yes", "--clients", "codex,opencode", "--shared", "--json", "--dry-run", "--language", "en"], "setup");
assert(!parsed.errors.length, `valid non-interactive options should parse: ${parsed.errors.join("; ")}`);
assert(parsed.explicitClients && parsed.options.clients.join(",") === "codex,opencode", "client multiselect flags should remain explicit");
assert(parsed.options.mode === "shared" && parsed.options.json && parsed.options.dryRun && parsed.options.language === "en", "hidden shared compatibility and output flags should parse");
assert(parseSetupArgs(["--yes", "--clients", "codex", "--local"], "setup").errors.some(error => error.includes("--local has been removed")), "removed local mode should fail explicitly");
const unset = parseSetupArgs(["--yes", "--clients", "all", "--remove-global"], "unset");
assert(unset.options.action === "unset" && unset.options.clients.length === 3 && unset.options.removeGlobal, "unset alias should share the same parser");
assert(parseSetupArgs(["--clients", "unknown"], "setup").errors.length === 1, "unknown clients should be rejected");
for (const token of ["setup", "unset", "--clients", "--yes", "--json", "--dry-run"]) {
  assert(setupHelp().includes(token), `help should expose ${token}`);
}
assert(!setupHelp().includes("--local") && !setupHelp().includes("--shared"), "help should not expose a deployment-mode choice");
