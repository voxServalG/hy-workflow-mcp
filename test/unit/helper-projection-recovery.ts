import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHelperCli } from "../../src/helper/cli.js";
import { defaultSkillBundleRoot } from "../../src/helper/skill-bundle.js";
import type { HelperSkillPaths } from "../../src/helper/skills.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-helper-projection-recovery-"));
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
  evidence: ["regression_fixture"],
}));
const dependencies = { paths, skillPaths: paths, detectedTargets, bundleRoot: defaultSkillBundleRoot() };

try {
  assert.equal((await runHelperCli(["install", "--clients", "all", "--mode", "copy", "--json"], dependencies)).exitCode, 0);
  const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8"));
  for (const name of ["hy-init", "hy-verify"]) {
    const skill = manifest.skills.find((candidate: { name: string }) => candidate.name === name);
    const projection = skill.projections.find((candidate: { agent: string }) => candidate.agent === "codex");
    projection.intentionalDeletion = true;
    fs.rmSync(projection.path, { recursive: true, force: true });
  }
  fs.writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const drifted = await runHelperCli(["status", "--json"], dependencies);
  assert.equal(drifted.exitCode, 0);
  assert.equal(drifted.envelope.status, "attention");
  assert.equal(drifted.envelope.skills.status, "drifted");
  assert((drifted.envelope.skills.findings as Array<{ code: string }>).some(finding => finding.code === "desired_projection_marked_deleted"));

  const updated = await runHelperCli(["update", "--json"], dependencies);
  assert.equal(updated.exitCode, 0);
  assert.equal(updated.envelope.skills.action, "updated");
  for (const name of ["hy-capture", "hy-init", "hy-verify"]) {
    assert(fs.existsSync(path.join(detectedTargets[0].skillsDir, name)), `Codex projection was not restored: ${name}`);
  }
  const repaired = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8"));
  assert(repaired.skills.every((skill: { intentionalDeletion: boolean; projections: Array<{ intentionalDeletion: boolean }> }) =>
    !skill.intentionalDeletion && skill.projections.every(projection => !projection.intentionalDeletion)));
  const healthy = await runHelperCli(["status", "--json"], dependencies);
  assert.equal(healthy.envelope.skills.status, "healthy");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write("helper projection recovery regression passed\n");
