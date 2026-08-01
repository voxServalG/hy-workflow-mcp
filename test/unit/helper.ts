import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHelperCli } from "../../src/helper/cli.js";
import { defaultSkillBundleRoot } from "../../src/helper/skill-bundle.js";
import type { HelperSkillPaths } from "../../src/helper/skills.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-workflow-helper-unit-"));
const paths: HelperSkillPaths = {
  dataRoot: path.join(root, "data"),
  stateRoot: path.join(root, "state"),
  ssotRoot: path.join(root, "data", "skills"),
  manifestPath: path.join(root, "state", "skill-ownership.json"),
  lockPath: path.join(root, "state", "skill-projector.lock"),
};
const detectedTargets = (["codex", "claude", "opencode"] as const).map(agent => ({
  agent,
  skillsDir: path.join(root, "agents", agent, "skills"),
  detected: true,
  evidence: ["unit_fixture"],
}));
const project = path.join(root, "unrelated-project");
fs.mkdirSync(project);
const sentinel = path.join(project, "sentinel.txt");
fs.writeFileSync(sentinel, "unchanged\n");

try {
  const dependencies = { paths, skillPaths: paths, detectedTargets, bundleRoot: defaultSkillBundleRoot() };
  const installed = await runHelperCli(
    ["install", "--clients", "all", "--mode", "copy", "--json"],
    dependencies,
  );
  assert.equal(installed.exitCode, 0);
  assert.equal(installed.envelope.schema, "hy-workflow.helper.v2");
  assert.equal(installed.envelope.status, "completed");
  const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8")) as {
    schemaVersion: string;
    skills: Array<{ name: string }>;
  };
  assert.equal(manifest.schemaVersion, "2");
  assert.deepEqual(manifest.skills.map(skill => skill.name).sort(), ["hy-capture", "hy-init", "hy-verify"]);
  for (const target of detectedTargets) {
    assert.deepEqual(fs.readdirSync(target.skillsDir).sort(), ["hy-capture", "hy-init", "hy-verify"]);
  }
  assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged\n");
  assert.equal(fs.existsSync(path.join(project, ".git")), false);

  const status = await runHelperCli(["status", "--json"], dependencies);
  assert.equal(status.exitCode, 0);
  assert.equal(status.envelope.skills.status, "healthy");

  const unchanged = await runHelperCli(["update", "--json"], dependencies);
  assert.equal(unchanged.exitCode, 0);
  assert.equal(unchanged.envelope.skills.action, "unchanged");

  const removed = await runHelperCli(["remove", "--json"], dependencies);
  assert.equal(removed.exitCode, 0);
  assert.equal(fs.existsSync(paths.ssotRoot), false);
  assert.equal(fs.existsSync(paths.manifestPath), false);
  for (const target of detectedTargets) {
    assert.deepEqual(fs.readdirSync(target.skillsDir), []);
  }
  assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write("helper unit tests passed\n");
