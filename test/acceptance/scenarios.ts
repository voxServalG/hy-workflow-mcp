import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { AcceptanceRepo, AcceptanceWorkspace } from "./harness.js";
import { validateLintPressureEnvelope, type LintPressureSummary } from "./lint-report.js";
import {
  ACCEPTANCE_SKILL_NAMES,
  assertProjectBoundary,
  assertWorkspaceDiskBudget,
  cliDocsBaseline,
  clonePinned,
  gitSnapshot,
  parseJsonOutput,
  run,
} from "./harness.js";

export type ScenarioResult = {
  name: string;
  repository?: string;
  durationMs: number;
  detail: Record<string, unknown>;
};

const COMPAT_FILES = ["codelint.json", "doclint.json", "docs-gardener.json"] as const;
const LINT_PRESSURE_TIMEOUT_MS = 120_000;
const PARSER_SCANNER_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rs"]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function compatibilitySnapshot(root: string): Map<string, Buffer | null> {
  return new Map(COMPAT_FILES.map(file => {
    const target = join(root, file);
    return [file, existsSync(target) ? readFileSync(target) : null];
  }));
}

function assertCompatibilityUnchanged(root: string, before: Map<string, Buffer | null>, context: string): void {
  for (const file of COMPAT_FILES) {
    const target = join(root, file);
    const expected = before.get(file) ?? null;
    if (expected === null) {
      assert(!existsSync(target), context + " left a new compatibility artifact " + file);
    } else {
      assert(existsSync(target) && readFileSync(target).equals(expected), context + " changed compatibility artifact bytes " + file);
    }
  }
}

async function runRepositoryLintPressure(
  workspace: AcceptanceWorkspace,
  root: string,
  repo: AcceptanceRepo,
): Promise<LintPressureSummary> {
  const before = compatibilitySnapshot(root);
  const result = await run("hy-workflow", ["lint", "--json"], {
    cwd: root,
    env: workspace.env,
    timeoutMs: LINT_PRESSURE_TIMEOUT_MS,
    allowFailure: true,
  });
  assertCompatibilityUnchanged(root, before, repo.id + " built-in lint");
  assert(!result.timedOut, repo.id + " built-in lint exceeded the outer timeout");
  const report = parseJsonOutput(result.stdout);
  const summary = validateLintPressureEnvelope({
    status: result.status,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    report,
  }, LINT_PRESSURE_TIMEOUT_MS);
  const parserSupported = repo.expected.codeExt.some(extension => PARSER_SCANNER_EXTENSIONS.has(extension));
  assert(summary.code > 0, repo.id + " built-in lint found no configured code files");
  assert(summary.notConfiguredRules.includes("C003"), repo.id + " C003 compatibility slot was not reported as not_configured");
  assert(summary.notApplicableRules.includes("C004"), repo.id + " C004 compatibility slot was not reported as not_applicable");
  if (parserSupported) {
    assert(!summary.notApplicableRules.includes("C005"), repo.id + " supported scanner was reported as N/A");
  } else {
    assert(summary.notApplicableRules.includes("C005"), repo.id + " unsupported language did not report C005 as N/A");
  }
  return summary;
}

function treeFingerprint(root: string): string {
  const hash = createHash("sha256");
  const walk = (directory: string): void => {
    if (!existsSync(directory)) {
      hash.update("absent:" + relative(root, directory) + "\n");
      return;
    }
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const rel = relative(root, file).replace(/\\/g, "/");
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        hash.update("l:" + rel + ":" + readlinkSync(file) + "\n");
      } else if (stat.isDirectory()) {
        hash.update("d:" + rel + "\n");
        walk(file);
      } else {
        hash.update("f:" + rel + ":" + stat.mode + ":");
        hash.update(readFileSync(file));
        hash.update("\n");
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}

export function isolatedUserStateFingerprint(workspace: AcceptanceWorkspace): string {
  const hash = createHash("sha256");
  for (const root of [
    join(workspace.home, ".config", "hy-workflow"),
    join(workspace.home, ".local", "share", "hy-workflow"),
    join(workspace.home, ".local", "state", "hy-workflow"),
    join(workspace.home, ".codex", "skills"),
  ]) {
    hash.update(root + ":" + treeFingerprint(root) + "\n");
  }
  const clientState = workspace.env.HY_ACCEPTANCE_CLIENT_STATE!;
  hash.update("client-state:");
  hash.update(existsSync(clientState) ? readFileSync(clientState) : Buffer.from("absent"));
  return hash.digest("hex");
}

function assertHelperEnvelope(envelope: any, command: string, ok = true): void {
  assert(envelope.schema === "hy-workflow.helper.v1" && envelope.version === 1, command + " helper schema drifted");
  assert(envelope.command === command && envelope.ok === ok, command + " helper result was not " + (ok ? "successful" : "failed"));
  assert(Array.isArray(envelope.projectFilesChanged) && envelope.projectFilesChanged.length === 0, command + " changed project files");
}

function assertSkillProjection(workspace: AcceptanceWorkspace): void {
  const skillsRoot = join(workspace.home, ".codex", "skills");
  for (const name of ACCEPTANCE_SKILL_NAMES) {
    const manifest = join(skillsRoot, name, "SKILL.md");
    assert(existsSync(manifest) && statSync(manifest).isFile(), "helper did not project " + name + " into Codex");
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function assertExternalProjectConfig(envelope: any, repo: AcceptanceRepo, root: string): void {
  const configPath = envelope.layers?.project?.configPath;
  assert(typeof configPath === "string" && existsSync(configPath), repo.id + " helper did not create an external config");
  assert(relative(root, configPath).startsWith(".."), repo.id + " helper config entered the project boundary");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert(config.project?.baseBranch === repo.defaultBranch, repo.id + " inferred wrong base branch");
  assert(config.project?.docsDir === repo.expected.docsDir, repo.id + " inferred wrong documentation root");
  const codeExt = stringList(config.project?.codeExt);
  const codeDirs = stringList(config.project?.codeDirs);
  const lintDirs = stringList(config.codelint?.lintDirs);
  for (const extension of repo.expected.codeExt) assert(codeExt.includes(extension), repo.id + " missed code extension " + extension);
  for (const directory of repo.expected.codeDirs) assert(codeDirs.includes(directory), repo.id + " missed code directory " + directory);
  for (const directory of repo.expected.lintDirs) assert(lintDirs.includes(directory), repo.id + " missed lint directory " + directory);
}

function assertInitCognition(init: any, repo: AcceptanceRepo): void {
  const cognition = init.cognition;
  assert(cognition?.schema === "hy-workflow.project-cognition.v1", repo.id + " init returned no project cognition");
  const platform = cognition.verificationPlatform;
  assert(platform?.scaleDecisionOwner === "skill", repo.id + " init assigned test-scale policy to the CLI");
  assert(platform?.completenessAuthority === "cli", repo.id + " init did not keep evidence completeness in the CLI");
  assert(Array.isArray(platform?.candidateCommands) && platform.candidateCommands.length > 0, repo.id + " init found no test platform");
  assert(Array.isArray(platform?.scales) && platform.scales.map((item: any) => item.scale).join(",") === "small,medium,large", repo.id + " init test-scale contract drifted");
  assert(cognition.documentation?.externalKnowledgeAccess === false, repo.id + " init attempted external knowledge access");
  assert(cognition.documentation?.pullRequestReview === "skill-read-only", repo.id + " init PR-review ownership drifted");
}

async function createFixtureProject(workspace: AcceptanceWorkspace, id: string): Promise<string> {
  const root = join(workspace.repos, id);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: id, scripts: { test: "node --test" } }, null, 2) + "\n");
  writeFileSync(join(root, "src", "index.js"), "export const value = 1;\n");
  writeFileSync(join(root, "docs", "index.md"), "# " + id + "\n\nAcceptance fact.\n");
  await run("git", ["init", "-b", "main"], { cwd: root, env: workspace.env });
  await run("git", ["config", "user.email", "acceptance@example.invalid"], { cwd: root, env: workspace.env });
  await run("git", ["config", "user.name", "Acceptance"], { cwd: root, env: workspace.env });
  await run("git", ["remote", "add", "origin", "https://example.invalid/" + id + ".git"], { cwd: root, env: workspace.env });
  await run("git", ["add", "."], { cwd: root, env: workspace.env });
  await run("git", ["commit", "-m", "fixture"], { cwd: root, env: workspace.env });
  await run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root, env: workspace.env });
  await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: root, env: workspace.env });
  return root;
}

export async function runRepositoryScenario(
  workspace: AcceptanceWorkspace,
  repo: AcceptanceRepo,
  index: number,
): Promise<ScenarioResult> {
  const started = Date.now();
  const root = await clonePinned(workspace, repo);
  const gitBefore = await gitSnapshot(root, workspace.env);
  const compatibilityBefore = compatibilitySnapshot(root);
  const statusBefore = await assertProjectBoundary(root, workspace.env);

  const installedResult = await run("hy-workflow", ["helper", "install", "--clients", "codex", "--mode", "copy", "--json"], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 60_000,
  });
  const installed = parseJsonOutput(installedResult.stdout);
  assertHelperEnvelope(installed, "install");
  assert(installed.layers?.skills?.skillCount === 12, repo.id + " helper did not own twelve Skills");
  assertExternalProjectConfig(installed, repo, root);
  assertSkillProjection(workspace);
  assert((await assertProjectBoundary(root, workspace.env)).length === 0, repo.id + " helper wrote into the project");

  const repeatedResult = await run("hy-workflow", ["helper", "install", "--clients", "codex", "--mode", "copy", "--json"], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 60_000,
  });
  const repeated = parseJsonOutput(repeatedResult.stdout);
  assertHelperEnvelope(repeated, "install");
  assert(repeated.layers?.skills?.status === "unchanged" && repeated.layers?.project?.status === "preserved", repo.id + " repeated helper install was not idempotent");

  const stateBeforeStatus = isolatedUserStateFingerprint(workspace);
  const statusResult = await run("hy-workflow", ["helper", "status", "--json"], { cwd: root, env: workspace.env });
  const status = parseJsonOutput(statusResult.stdout);
  assertHelperEnvelope(status, "status");
  assert(status.layers?.skills?.status === "healthy" && status.layers?.project?.status === "registered", repo.id + " helper status was not healthy");
  assert(isolatedUserStateFingerprint(workspace) === stateBeforeStatus, repo.id + " helper status was not read-only");

  const lintPressure = await runRepositoryLintPressure(workspace, root, repo);
  const docs = await cliDocsBaseline(workspace, root, "Update project usage and setup documentation");
  assert(docs.chars > 0 && docs.chars <= 48_000, repo.id + " docs baseline exceeded the 48k policy");
  assertInitCognition(docs.init, repo);
  assertCompatibilityUnchanged(root, compatibilityBefore, repo.id + " complete CLI lifecycle");
  assert((await assertProjectBoundary(root, workspace.env)).join(",") === statusBefore.join(","), repo.id + " CLI lifecycle changed the project worktree");
  assert(JSON.stringify(await gitSnapshot(root, workspace.env)) === JSON.stringify(gitBefore), repo.id + " CLI lifecycle changed Git identity");

  const removedResult = await run("hy-workflow", ["helper", "remove", "--json"], { cwd: root, env: workspace.env });
  const removed = parseJsonOutput(removedResult.stdout);
  assertHelperEnvelope(removed, "remove");
  assert(removed.layers?.skills?.status === "removed" && removed.layers?.project?.status === "preserved", repo.id + " helper remove crossed its ownership boundary");
  assert(!existsSync(join(workspace.home, ".local", "state", "hy-workflow", "skill-ownership.json")), repo.id + " helper remove left ownership state");
  await assertProjectBoundary(root, workspace.env);
  assertWorkspaceDiskBudget(workspace);

  return {
    name: "repository-" + (index + 1),
    repository: repo.id,
    durationMs: Date.now() - started,
    detail: {
      helperInstall: installed.layers,
      helperIdempotent: repeated.layers.skills.status,
      docsChars: docs.chars,
      cognition: docs.init.cognition.verificationPlatform,
      lintPressure,
      projectFilesChanged: installed.projectFilesChanged,
    },
  };
}

export async function runConcurrencyScenario(workspace: AcceptanceWorkspace): Promise<ScenarioResult> {
  const started = Date.now();
  const root = await createFixtureProject(workspace, "concurrency-32");
  const commands = Array.from({ length: 32 }, () =>
    run("hy-workflow", ["helper", "install", "--clients", "codex", "--mode", "copy", "--json"], {
      cwd: root,
      env: workspace.env,
      timeoutMs: 90_000,
      allowFailure: true,
    })
  );
  const results = await Promise.all(commands);
  let successes = 0;
  let retryableContention = 0;
  for (const result of results) {
    const envelope = parseJsonOutput(result.stdout);
    if (result.status === 0) {
      assertHelperEnvelope(envelope, "install");
      successes += 1;
    } else {
      assertHelperEnvelope(envelope, "install", false);
      assert(envelope.error?.code === "HELPER_SKILL_BUSY" && envelope.error?.retryable === true, "concurrency accepted an error other than HELPER_SKILL_BUSY: " + result.stdout);
      retryableContention += 1;
    }
  }
  assert(successes > 0 && successes + retryableContention === 32, "concurrency-32 did not account for every worker");

  const recoveredResult = await run("hy-workflow", ["helper", "install", "--clients", "codex", "--mode", "copy", "--json"], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 60_000,
  });
  const recovered = parseJsonOutput(recoveredResult.stdout);
  assertHelperEnvelope(recovered, "install");
  const status = parseJsonOutput((await run("hy-workflow", ["helper", "status", "--json"], { cwd: root, env: workspace.env })).stdout);
  assertHelperEnvelope(status, "status");
  assert(status.layers?.skills?.status === "healthy" && status.layers?.project?.status === "registered", "postContentionRecovery did not converge");
  assertSkillProjection(workspace);
  await assertProjectBoundary(root, workspace.env);
  await run("hy-workflow", ["helper", "remove", "--json"], { cwd: root, env: workspace.env });

  return {
    name: "concurrency-32",
    durationMs: Date.now() - started,
    detail: { workers: 32, successes, retryableContention, postContentionRecovery: "healthy" },
  };
}

export async function runFaultScenario(workspace: AcceptanceWorkspace): Promise<ScenarioResult> {
  const started = Date.now();
  const root = await createFixtureProject(workspace, "helper-projector-atomic-rollback");
  const installed = parseJsonOutput((await run("hy-workflow", ["helper", "install", "--clients", "codex", "--mode", "copy", "--json"], {
    cwd: root,
    env: workspace.env,
  })).stdout);
  assertHelperEnvelope(installed, "install");
  const packageRoot = workspace.env.HY_ACCEPTANCE_PACKAGE_ROOT;
  assert(packageRoot, "fault scenario has no installed package root");
  const helperFaultChild = join(workspace.sourceRoot, "test", "acceptance", "helper-fault-child.mjs");
  const points = ["after-mutation-1", "after-mutation-8", "before-manifest"];

  for (const point of points) {
    const before = isolatedUserStateFingerprint(workspace);
    const fault = await run(process.execPath, [helperFaultChild, packageRoot, point, "fail"], {
      cwd: root,
      env: workspace.env,
      timeoutMs: 60_000,
    });
    const evidence = parseJsonOutput(fault.stdout);
    assert(evidence.ok === true && evidence.injected === point && evidence.rolledBack === true, point + " fault child returned incomplete rollback evidence");
    assert(isolatedUserStateFingerprint(workspace) === before, point + " changed isolated user state after rollback");

    const converged = await run(process.execPath, [helperFaultChild, packageRoot, point, "converge"], {
      cwd: root,
      env: workspace.env,
      timeoutMs: 60_000,
    });
    assert(parseJsonOutput(converged.stdout).ok === true, point + " did not converge after rollback");
    const status = parseJsonOutput((await run("hy-workflow", ["helper", "status", "--json"], { cwd: root, env: workspace.env })).stdout);
    assertHelperEnvelope(status, "status");
    assert(status.layers?.skills?.status === "healthy", point + " left the Skill projector unhealthy");
  }
  const killPoints = ["after-mutation-1", "after-mutation-8"];
  for (const point of killPoints) {
    const before = isolatedUserStateFingerprint(workspace);
    const killed = await run(process.execPath, [helperFaultChild, packageRoot, point, "kill"], {
      cwd: root,
      env: workspace.env,
      timeoutMs: 60_000,
      allowFailure: true,
    });
    assert(!killed.timedOut && (killed.signal === "SIGKILL" || killed.status >= 128), point + " did not terminate the projector process");

    const recoveredStatus = parseJsonOutput((await run("hy-workflow", ["helper", "status", "--json"], {
      cwd: root,
      env: workspace.env,
      timeoutMs: 60_000,
    })).stdout);
    assertHelperEnvelope(recoveredStatus, "status");
    assert(recoveredStatus.layers?.skills?.status === "healthy", point + " was not recovered by the next CLI status");
    assert(isolatedUserStateFingerprint(workspace) === before, point + " did not restore the exact pre-crash external state");
  }


  await run(process.execPath, [helperFaultChild, packageRoot, "none", "remove"], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 60_000,
  });
  await assertProjectBoundary(root, workspace.env);
  return {
    name: "helper-projector-faults",
    durationMs: Date.now() - started,
    detail: { points, beforeManifestWrite: true, afterMutation: true, oracle: "helper projector atomic rollback" },
  };
}
