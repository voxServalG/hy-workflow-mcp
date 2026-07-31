import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeDeployment } from "../../src/runtime/deployment.js";
import { RUNTIME_CONFIG_SOURCE_ENV, RUNTIME_CONFIG_SOURCE_SCHEMA } from "../../src/config.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { assertProjectBoundary, parseJsonOutput, run, type AcceptanceWorkspace } from "./harness.js";
import { writeFixture } from "./baseline-harness.js";
import { runMergeRecoveryIncident } from "./merge-recovery-incident.js";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

function overlayEnvironment(environment: NodeJS.ProcessEnv): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function runSeamlessUpgradeIncident(workspace: AcceptanceWorkspace, fixture: any): Promise<Record<string, unknown>> {
  const started = Date.now();
  const root = join(workspace.repos, fixture.id);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  await run("git", ["init", "-b", "main"], { cwd: root, env: workspace.env });
  await run("git", ["config", "user.email", "acceptance@example.invalid"], { cwd: root, env: workspace.env });
  await run("git", ["config", "user.name", "Acceptance"], { cwd: root, env: workspace.env });
  await run("git", ["remote", "add", "origin", "https://example.invalid/read-only.git"], { cwd: root, env: workspace.env });

  const legacyFiles = new Map<string, string>([
    ["src/index.ts", "export const value = 1;\n"],
    ["docs/index.md", "# Legacy project\n\nAcceptance baseline fact.\n"],
    ["hy-workflow.json", "{ this old injected config is intentionally invalid json\n"],
    [".github/workflows/hy-workflow.yml", "name: legacy injected workflow\non: [push]\n"],
    ["AGENTS.md", "<!-- hy-workflow-rules -->\nlegacy injected rules\n<!-- /hy-workflow-rules -->\n"],
    ["codelint.json", "{\"legacy\":true}\n"],
    ["doclint.json", "{\"legacy\":true}\n"],
    ["docs-gardener.json", "{\"legacy\":true}\n"],
  ]);
  for (const [relative, content] of legacyFiles) writeFileSync(join(root, relative), content);
  await run("git", ["add", "."], { cwd: root, env: workspace.env });
  await run("git", ["commit", "-m", "legacy installed project"], { cwd: root, env: workspace.env });
  await run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root, env: workspace.env });
  await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: root, env: workspace.env });

  const restoreEnvironment = overlayEnvironment(workspace.env);
  let stateFile: string;
  try {
    writeDeployment(root, {
      setupVersion: "2026.01.01.0",
      mode: "shared",
      clients: [],
      projectFiles: ["hy-workflow.json", ".github/workflows/hy-workflow.yml", "AGENTS.md"],
      tools: {},
      artifacts: {
        "hy-workflow.json": { sha256: "0".repeat(64), size: 1 },
        ".github/workflows/hy-workflow.yml": { sha256: "1".repeat(64), size: 1 },
        "AGENTS.md": { sha256: "2".repeat(64), size: 1 },
      },
    });
    stateFile = projectPaths(root).workflowState;
  } finally {
    restoreEnvironment();
  }
  mkdirSync(join(stateFile, ".."), { recursive: true });
  const activeState = "{\"phase\":\"edit\",\"approval\":{\"decisionId\":\"legacy-approved\"}}\n";
  writeFileSync(stateFile, activeState);
  const before = new Map([...legacyFiles].map(([relative]) => [relative, readFileSync(join(root, relative), "utf-8")]));
  const beforeStatus = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;

  for (const args of [
    ["setup", "--dry-run", "--yes", "--clients", "codex", "--json", "--language", "en"],
    ["setup", "--yes", "--clients", "codex", "--json", "--language", "en"],
  ]) {
    const result = await run("hy-workflow", args, { cwd: root, env: workspace.env });
    assert(parseJsonOutput(result.stdout).ok === true, `${fixture.id} ${args.includes("--dry-run") ? "dry-run" : "upgrade"} failed`);
  }

  for (const [relative, content] of before) {
    assert(readFileSync(join(root, relative), "utf-8") === content, `${fixture.id} did not preserve legacy injection ${relative} byte-for-byte`);
  }
  assert(readFileSync(stateFile, "utf-8") === activeState, `${fixture.id} changed active workflow or approval state`);
  assert((await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout === beforeStatus, `${fixture.id} dirtied the project worktree`);
  return { name: fixture.id, incident: fixture.incident, legacyInjections: "inert", durationMs: Date.now() - started };
}

export async function runBaselineFixture(workspace: AcceptanceWorkspace, fixture: any): Promise<Record<string, unknown>> {
  if (fixture.kind === "merge-recovery") {
    return runMergeRecoveryIncident({
      ...workspace,
      env: { ...workspace.env, [RUNTIME_CONFIG_SOURCE_ENV]: RUNTIME_CONFIG_SOURCE_SCHEMA },
    }, fixture);
  }
  if (fixture.kind === "seamless-upgrade") return runSeamlessUpgradeIncident(workspace, fixture);
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
  const preview = parseJsonOutput(dry.stdout);
  assert(preview.ok === true, `${fixture.id} dry-run failed`);
  const exactReviews = (preview.artifactChanges ?? []).filter((change: any) => change.requiresAcceptance).flatMap((change: any) => [
    "--review-artifact",
    `${change.file}:${change.beforeHash ?? "absent"}:${change.afterHash}`,
  ]);
  assert((await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout === "", `${fixture.id} dry-run mutated project`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const setup = await run("hy-workflow", [
      "setup", "--yes", "--clients", "codex", "--json", "--language", "en",
      ...(attempt === 0 && exactReviews.length ? ["--accept-artifact-changes", ...exactReviews] : []),
    ], { cwd: root, env: workspace.env });
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
  for (const artifact of ["hy-workflow.json", ".github/workflows/hy-workflow.yml"]) assert(existsSync(join(root, artifact)), `${fixture.id} unset removed ${artifact}`);
  assert(!existsSync(join(root, "AGENTS.md")), `${fixture.id} fresh setup injected AGENTS.md`);
  for (const runtime of [".hy", ".codex", ".mcp.json", "codelint.json", "doclint.json", "docs-gardener.json"]) assert(!existsSync(join(root, runtime)), `${fixture.id} left ${runtime}`);
  const config = JSON.parse(readFileSync(join(root, "hy-workflow.json"), "utf8"));
  assert(config.project.baseBranch === fixture.branch, `${fixture.id} base branch drift`);
  return { name: fixture.id, incident: fixture.incident, lint: lintReport.counts, durationMs: Date.now() - started };
}
