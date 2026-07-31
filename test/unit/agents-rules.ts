import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGENTS_CLOSE,
  AGENTS_OPEN,
  ASYNC_VERIFY_GUIDANCE,
  canonicalManagedBlock,
  extractManagedBlock,
  outsidePreserved,
  planAgentsFile,
} from "../../src/setup/agents-rules.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const canonical = canonicalManagedBlock();
assert(canonical === "", "retired compatibility export must not provide injectable project instructions");
assert(ASYNC_VERIFY_GUIDANCE.includes("hy_exam_plan") && ASYNC_VERIFY_GUIDANCE.includes("hy_verify"), "compatibility guidance export must remain meaningful");
assert(extractManagedBlock(`${AGENTS_OPEN}\nlegacy\n${AGENTS_CLOSE}`).wellFormed, "pure managed-block parser must remain available for old callers");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-agents-inert-"));
const target = path.join(root, "AGENTS.md");
const legacy = `${AGENTS_OPEN}\nold injected policy\n${AGENTS_CLOSE}\nteam-owned content\n`;
fs.writeFileSync(target, legacy);

const planned = planAgentsFile(root);
assert(!planned.changed && planned.changeKind === "none", "AGENTS setup plan must be permanently inert");
assert(planned.previousContent === null && planned.nextContent === "", "inert plan must not expose or reinterpret target bytes");
assert(fs.readFileSync(target, "utf-8") === legacy, "inert AGENTS planning must not mutate project content");
assert(outsidePreserved(root, "intentionally-wrong"), "deprecated outside check must not open the legacy project file");

console.log("agents-rules: compatibility parser retained without a packaged injection source");
