import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultSkillBundleRoot } from "../../src/helper/skill-bundle.js";
import type { HelperSkillPaths } from "../../src/helper/skills.js";
import { runHelperTui, type HelperTuiPrompts } from "../../src/helper/tui.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-helper-tui-"));
const paths: HelperSkillPaths = {
  dataRoot: path.join(root, "data"),
  stateRoot: path.join(root, "state"),
  ssotRoot: path.join(root, "data", "skills"),
  manifestPath: path.join(root, "state", "skill-ownership.json"),
  lockPath: path.join(root, "state", "skill-projector.lock"),
};
const detectedTargets = (["codex", "claude", "opencode"] as const).map(agent => ({
  agent, skillsDir: path.join(root, "agents", agent, "skills"), detected: true, evidence: ["tui_fixture"],
}));
const dependencies = { paths, skillPaths: paths, detectedTargets, bundleRoot: defaultSkillBundleRoot() };

function ui(values: unknown[], events: string[]): HelperTuiPrompts {
  const next = async () => values.shift() as never;
  return {
    intro: message => events.push(`intro:${message}`),
    outro: message => events.push(`outro:${message}`),
    cancel: message => events.push(`cancel:${message}`),
    note: (message, title) => events.push(`note:${title ?? ""}:${message}`),
    select: next,
    multiselect: next,
    confirm: next,
    isCancel: value => typeof value === "symbol",
  };
}

try {
  const cancelledEvents: string[] = [];
  assert.equal(await runHelperTui(dependencies, ui([Symbol("cancel")], cancelledEvents)), 0);
  assert(cancelledEvents.some(event => event.startsWith("cancel:")));
  assert.equal(fs.existsSync(paths.manifestPath), false, "cancelled TUI must not mutate ownership state");

  const installedEvents: string[] = [];
  assert.equal(await runHelperTui(dependencies, ui(["install", ["codex", "claude", "opencode"], "copy", true], installedEvents)), 0);
  assert(fs.existsSync(paths.manifestPath));
  assert(installedEvents.some(event => event === "outro:完成。"));
  for (const target of detectedTargets) assert.deepEqual(fs.readdirSync(target.skillsDir).sort(), ["hy-capture", "hy-init", "hy-verify"]);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write("helper TUI headless navigation passed\n");
