import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const skillsRoot = path.join(root, "skills");
const expected = ["hy-capture", "hy-init", "hy-verify"];
assert.deepEqual(fs.readdirSync(skillsRoot).sort(), expected);

const removedCommands = /hy-workflow (?:approve|amend-plan|branch|commit|exam-plan|exam-submit|merge|read-docs|reset|status|sync-docs)\b/;
for (const name of expected) {
  const skillFile = path.join(skillsRoot, name, "SKILL.md");
  const content = fs.readFileSync(skillFile, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  assert(match, `${name} must have closed frontmatter`);
  const document = parseDocument(match[1], { uniqueKeys: true, strict: true, schema: "core" });
  assert.equal(document.errors.length, 0);
  const metadata = document.toJS() as Record<string, unknown>;
  assert.deepEqual(Object.keys(metadata).sort(), ["description", "name"]);
  assert.equal(metadata.name, name);
  assert.equal(typeof metadata.description, "string");
  assert.match(String(metadata.description), /Use when/);
  assert.match(String(metadata.description), /Do not/);
  assert.match(content, /CLI (?:is not|status is never|status is a fact|is not an access gate)/i);
  assert.doesNotMatch(content, removedCommands, `${name} must not reference removed workflow commands`);

  const references = [...content.matchAll(/\]\(references\/([^)]+\.md)\)/g)].map(item => item[1]);
  assert(references.length > 0, `${name} must route detailed rules to one-level references`);
  for (const reference of references) {
    assert(!reference.includes("/"), `${name} references must stay one level deep`);
    assert(fs.statSync(path.join(skillsRoot, name, "references", reference)).isFile());
  }
}

const init = fs.readFileSync(path.join(skillsRoot, "hy-init", "SKILL.md"), "utf8");
assert.match(init, /read-only project map/i);
assert.match(init, /read only obligation sources that apply/i);

const verify = fs.readFileSync(path.join(skillsRoot, "hy-verify", "SKILL.md"), "utf8");
assert.match(verify, /execute each issued `argv` directly/i);
assert.match(verify, /Supplemental checks never erase an issued obligation/i);

const capture = fs.readFileSync(path.join(skillsRoot, "hy-capture", "SKILL.md"), "utf8");
assert.match(capture, /impact, root cause, a regression oracle/i);
assert.match(capture, /There is no capture CLI command/i);

process.stdout.write("skill contract tests passed\n");
