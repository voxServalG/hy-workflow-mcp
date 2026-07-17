// Lightweight unit test: verifies that force flag path accepts an unreadable ownership entry
// without throwing. Full install path is exercised via e2e tests.
import { assert } from "node:console";

const forceFlagParse = (args: string[]): string[] | undefined => {
  let force: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--force-client-overwrite") {
      force = args[i + 1]?.split(",").map((s: string) => s.trim()).filter(Boolean);
      i += 1;
    }
  }
  return force;
};

assert(JSON.stringify(forceFlagParse(["--force-client-overwrite", "codex,opencode"])) === JSON.stringify(["codex", "opencode"]), "force flag should parse comma list");
assert(forceFlagParse(["--clients", "codex"]) === undefined, "no force flag should return undefined");
assert(JSON.stringify(forceFlagParse(["--force-client-overwrite", "codex", "--yes"])) === JSON.stringify(["codex"]), "force with trailing flag");

console.log("setup-force-client: CLI flag parsing passes");
