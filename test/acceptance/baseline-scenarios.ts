import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertProjectBoundary, parseJsonOutput, run, type AcceptanceWorkspace } from "./harness.js";
import { writeFixture } from "./baseline-harness.js";
import { runMergeRecoveryIncident } from "./merge-recovery-incident.js";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export async function runBaselineFixture(workspace: AcceptanceWorkspace, fixture: any): Promise<Record<string, unknown>> {
  if (fixture.kind === "merge-recovery") return runMergeRecoveryIncident(workspace, fixture);
  if (fixture.kind !== undefined && fixture.kind !== "project-shape") throw new Error(`Unknown baseline fixture kind: ${fixture.kind}`);
  const started = Date.now();
  const root = join(workspace.repos, fixture.id);
  mkdirSync(root, { recursive: true });
  writeFixture(root, fixture);
  await run("git", ["init", "-b", fixture.branch], { cwd: root, env: workspace.env });
  await run("git", ["config", "user.email", "acceptance@example.invalid"], { cwd: root, env: workspace.env });
  await run("git", ["config", "user.name", "Acceptance"], { cwd: root, env: workspace.env });
  await run("git", ["remote", "add", "origin", "https://example.invalid/read-only.git"], { cwd: root, env: workspace.env });
  await run("git", ["add", "."], { cwd: root, env: workspace.env });
  await run("git", ["commit", "-m", "fixture"], { cwd: root, env: workspace.env });
  await run("git", ["update-ref", `refs/remotes/origin/${fixture.branch}`, "HEAD"], { cwd: root, env: workspace.env });
  await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${fixture.branch}`], { cwd: root, env: workspace.env });

  const dry = await run("hy-workflow", ["setup", "--dry-run", "--yes", "--clients", "codex", "--json", "--language", "en"], { cwd: root, env: workspace.env });
  assert(parseJsonOutput(dry.stdout).ok === true, `${fixture.id} dry-run failed`);
  assert((await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout === "", `${fixture.id} dry-run mutated project`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const setup = await run("hy-workflow", ["setup", "--yes", "--clients", "codex", "--json", "--language", "en"], { cwd: root, env: workspace.env });
    assert(parseJsonOutput(setup.stdout).ok === true, `${fixture.id} setup ${attempt + 1} failed`);
  }
  await assertProjectBoundary(root, workspace.env);
  const doctor = await run("hy-workflow", ["doctor", "--offline", "--json"], { cwd: root, env: workspace.env });
  assert(parseJsonOutput(doctor.stdout).ok === true, `${fixture.id} doctor failed`);
  const lint = await run("hy-workflow", ["lint", "--json"], { cwd: root, env: workspace.env, allowFailure: true });
  const lintReport = parseJsonOutput(lint.stdout);
  assert(lint.status === 0, `${fixture.id} built-in lint failed: ${lint.stderr || lint.stdout}`);
  assert(lintReport.schema === "hy-workflow.lint.v1" && lintReport.version === 1, `${fixture.id} lint report schema drift`);
  assert(lintReport.ok === true && lintReport.counts?.errors === 0 && lintReport.counts?.docs > 0, `${fixture.id} lint report was not a clean documented scan`);
  assert(Array.isArray(lintReport.checks) && lintReport.checks.length === 10, `${fixture.id} lint did not report D001-D005/C001-C005`);
  for (const runtime of ["codelint.json", "doclint.json", "docs-gardener.json"]) assert(!existsSync(join(root, runtime)), `${fixture.id} lint created ${runtime}`);
  await run("hy-workflow", ["unset", "--yes", "--clients", "all", "--remove-global", "--json", "--language", "en"], { cwd: root, env: workspace.env });
  for (const artifact of ["hy-workflow.json", ".github/workflows/hy-workflow.yml", "AGENTS.md"]) assert(existsSync(join(root, artifact)), `${fixture.id} unset removed ${artifact}`);
  for (const runtime of [".hy", ".codex", ".mcp.json", "codelint.json", "doclint.json", "docs-gardener.json"]) assert(!existsSync(join(root, runtime)), `${fixture.id} left ${runtime}`);
  const config = JSON.parse(readFileSync(join(root, "hy-workflow.json"), "utf8"));
  assert(config.project.baseBranch === fixture.branch, `${fixture.id} base branch drift`);
  return { name: fixture.id, incident: fixture.incident, lint: lintReport.counts, durationMs: Date.now() - started };
}
