import * as fs from "node:fs";
import * as path from "node:path";
import { MANAGED_RULES_VERSION } from "../../src/policy/docs.js";
import { extractManagedBlock, canonicalManagedBlock, planAgentsFile, AGENTS_OPEN, AGENTS_CLOSE, ASYNC_VERIFY_GUIDANCE } from "../../src/setup/agents-rules.js";
import { makeGitProject } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const canonical = canonicalManagedBlock();
assert(canonical.startsWith(AGENTS_OPEN), "canonical block must start with open marker");
assert(canonical.includes(AGENTS_CLOSE), "canonical block must contain close marker");
assert(ASYNC_VERIFY_GUIDANCE.includes("hy_exam_plan") && ASYNC_VERIFY_GUIDANCE.includes("hy_exam_submit") && ASYNC_VERIFY_GUIDANCE.includes("verifyHash"), "generated rule source must expose async verify guidance");
assert(canonical.includes(`hy-workflow-rules-version: ${MANAGED_RULES_VERSION}`), "canonical block must carry current version");

const fresh = extractManagedBlock("prefix\n" + canonical.trimEnd() + "\nsuffix\n");
assert(fresh.found && fresh.wellFormed, "well-formed block must be detected");
assert(fresh.current, "canonical version must be detected as current");
assert(fresh.preOutside === "prefix\n" && fresh.postOutside === "\nsuffix\n", "outside segments must be captured verbatim");

const staleNoVersion = extractManagedBlock(`${AGENTS_OPEN}\nstale body\n${AGENTS_CLOSE}\n# team notes\n`);
assert(staleNoVersion.found && staleNoVersion.wellFormed, "block without version is still well-formed");
assert(!staleNoVersion.current, "missing version must be non-current");
assert(staleNoVersion.version === null, "missing version must parse to null");

const staleOldVersion = extractManagedBlock(`${AGENTS_OPEN}\n<!-- hy-workflow-rules-version: 2020.01.01 -->\nold body\n${AGENTS_CLOSE}\n`);
assert(staleOldVersion.found && staleOldVersion.wellFormed && !staleOldVersion.current, "old version must be detected as stale");
assert(staleOldVersion.version === "2020.01.01", "old version string must be captured");

const malformedNoClose = extractManagedBlock(`${AGENTS_OPEN}\nbody without close\n`);
assert(!malformedNoClose.wellFormed, "missing close marker must be malformed");
assert(malformedNoClose.preOutside.includes("body without close"), "malformed content must be treated as outside");

const doubleOpen = extractManagedBlock(`${AGENTS_OPEN}\n${AGENTS_OPEN}\nbody\n${AGENTS_CLOSE}\n`);
assert(doubleOpen.wellFormed, "duplicate open markers inside the block are tolerated");

const root = makeGitProject("hy-agents-rules-");
const target = path.join(root, "AGENTS.md");

const created = planAgentsFile(root);
assert(created.changed && created.changeKind === "create", "fresh project must plan AGENTS.md creation");
assert(!fs.existsSync(target), "planAgentsFile must be read-only on create");
assert(created.nextContent.includes(`hy-workflow-rules-version: ${MANAGED_RULES_VERSION}`), "created file must include current version");
assert(created.outsidePreserved, "creation preserves no prior outside content");

fs.writeFileSync(target, canonical + "\n");
const unchanged = planAgentsFile(root);
assert(!unchanged.changed && unchanged.changeKind === "none", "current file must plan no change");

fs.writeFileSync(target, `${AGENTS_OPEN}\n<!-- hy-workflow-rules-version: 2020.01.01 -->\nold body\n${AGENTS_CLOSE}\n# team custom\n`);
const updated = planAgentsFile(root);
assert(updated.changed && updated.changeKind === "managed_update", "stale block must plan managed_update");
assert(updated.nextContent.endsWith("# team custom\n"), "trailing custom content must be preserved");
assert(!updated.nextContent.includes("old body"), "stale block content must be replaced");
assert(updated.outsidePreserved, "outside hash must match before/after managed_update");

fs.writeFileSync(target, `# preamble\n\n${AGENTS_OPEN}\n<!-- hy-workflow-rules-version: 2020.01.01 -->\nold body\n${AGENTS_CLOSE}\n## Appendix\nteam extra\n`);
const preserved = planAgentsFile(root);
assert(preserved.changed && preserved.changeKind === "managed_update" && preserved.outsidePreserved, "wrapping custom content must be preserved");
assert(preserved.nextContent.startsWith("# preamble\n\n"), "pre-block content must be preserved");
assert(preserved.nextContent.includes("## Appendix\nteam extra"), "post-block content must be preserved");

fs.writeFileSync(target, "# legacy content without markers\nolder instructions\n");
const inserted = planAgentsFile(root);
assert(inserted.changed && inserted.changeKind === "managed_insert", "file without markers must plan managed_insert");
assert(inserted.nextContent.startsWith(AGENTS_OPEN), "inserted block must lead the file");
assert(inserted.nextContent.includes("legacy content without markers"), "original content must follow the inserted block");
assert(inserted.outsidePreserved, "insert must preserve the full prior content after the inserted block");

console.log("agents-rules: extraction, canonical version, create/update/insert/none cases pass");
