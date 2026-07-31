import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { AcceptanceRepo, AcceptanceWorkspace } from "./harness.js";
import { validateLintPressureEnvelope, type LintPressureSummary } from "./lint-report.js";
import {
  assertProjectBoundary,
  assertWorkspaceDiskBudget,
  clonePinned,
  gitSnapshot,
  mcpDocsBaseline,
  parseJsonOutput,
  probeTui,
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
const DEPENDENCY_SCANNER_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rs"]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function exactArtifactReviewArgs(envelope: any, context: string): string[] {
  const changes = envelope?.artifactChanges;
  assert(Array.isArray(changes), context + " reported no artifact change list");
  const reviewed = changes.filter((change: any) => change?.requiresAcceptance);
  assert(reviewed.length > 0, context + " reported no artifact drift requiring review");
  return reviewed.flatMap((change: any) => {
    const before = change.beforeHash === null ? "absent" : change.beforeHash;
    assert(typeof change.file === "string" && change.file.length > 0 && !change.file.includes(":"), context + " reported an invalid artifact path");
    assert(before === "absent" || /^[a-f0-9]{64}$/.test(before), context + " reported an invalid artifact before hash");
    assert(typeof change.afterHash === "string" && /^[a-f0-9]{64}$/.test(change.afterHash), context + " reported an invalid artifact after hash");
    return ["--review-artifact", `${change.file}:${before}:${change.afterHash}`];
  });
}

function filesFingerprint(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      const rel = relative(root, file).replace(/\\/g, "/");
      const stat = statSync(file);
      if (stat.isDirectory()) {
        hash.update("d:" + rel + "\n");
        walk(file);
      } else {
        hash.update("f:" + rel + ":" + stat.mode + ":");
        hash.update(readFileSync(file));
      }
    }
  };
  walk(root);
  return hash.digest("hex");
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
      continue;
    }
    assert(existsSync(target), context + " removed existing compatibility artifact " + file);
    assert(readFileSync(target).equals(expected), context + " changed compatibility artifact bytes " + file);
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
  const supported = repo.expected.codeExt.some(extension => DEPENDENCY_SCANNER_EXTENSIONS.has(extension));
  assert(summary.code > 0, repo.id + " built-in lint found no configured code files");
  if (supported) {
    assert(!summary.notApplicableRules.includes("C004"), repo.id + " supported dependency graph was reported as N/A");
    assert(!summary.notApplicableRules.includes("C005"), repo.id + " supported scanner was reported as N/A");
  } else {
    assert(summary.notApplicableRules.includes("C004"), repo.id + " unsupported language did not report an honest C004 N/A");
    assert(summary.notApplicableRules.includes("C005"), repo.id + " unsupported language did not report an honest C005 N/A");
  }
  return summary;
}

export function isolatedUserStateFingerprint(workspace: AcceptanceWorkspace): string {
  const hash = createHash("sha256");
  hash.update("home:" + filesFingerprint(workspace.home) + "\n");
  const clientState = workspace.env.HY_ACCEPTANCE_CLIENT_STATE!;
  hash.update("client-state:" + (existsSync(clientState) ? readFileSync(clientState) : Buffer.from("absent")));
  return hash.digest("hex");
}

function configArgs(repo: AcceptanceRepo): string[] {
  return [
    "config", "--apply", "--json",
    "--code-ext", repo.expected.codeExt.join(","),
    "--code-dirs", repo.expected.codeDirs.join(","),
    "--lint-dirs", repo.expected.lintDirs.join(","),
    "--docs-dir", repo.expected.docsDir,
    "--base-branch", repo.defaultBranch,
  ];
}

async function ensureProjectConfig(workspace: AcceptanceWorkspace, root: string, repo: AcceptanceRepo): Promise<void> {
  const checked = await run("hy-workflow", ["config", "--check", "--json"], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 20_000,
    allowFailure: true,
  });
  let envelope: any = null;
  try { envelope = parseJsonOutput(checked.stdout); } catch {}
  const validCandidate = envelope?.ok === true
    && envelope?.candidate?.project
    && envelope?.candidate?.codelint
    ? envelope.candidate
    : null;
  const inferred = validCandidate ? {
    codeExt: validCandidate.project.codeExt,
    codeDirs: validCandidate.project.codeDirs,
    lintDirs: validCandidate.codelint.lintDirs,
    docsDir: validCandidate.project.docsDir,
    baseBranch: validCandidate.project.baseBranch,
    ciCommands: validCandidate.ci?.commands?.length
      ? validCandidate.ci.commands
      : envelope?.suggestion?.ciCommands,
  } : envelope?.suggestion ?? envelope?.candidate ?? envelope?.config;
  assert(inferred && typeof inferred === "object", repo.id + " config --check returned no inspectable inference: " + checked.stdout);
  const inferredList = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string" ? value.split(",").map(item => item.trim()).filter(Boolean) : [];
  const inferredExt = inferredList(inferred.codeExt);
  const inferredCodeDirs = inferredList(inferred.codeDirs);
  const inferredLintDirs = inferredList(inferred.lintDirs);
  const inferredCiCommands = inferredList(inferred.ciCommands);
  assert(inferred.baseBranch === repo.defaultBranch, repo.id + " inferred wrong base branch: " + JSON.stringify(inferred));
  for (const ext of repo.expected.codeExt) assert(inferredExt.includes(ext), repo.id + " inference missed codeExt " + ext + ": " + JSON.stringify(inferred));
  for (const dir of repo.expected.codeDirs) assert(inferredCodeDirs.includes(dir), repo.id + " inference missed codeDir " + dir + ": " + JSON.stringify(inferred));
  for (const dir of repo.expected.lintDirs) assert(inferredLintDirs.includes(dir), repo.id + " inference missed lintDir " + dir + ": " + JSON.stringify(inferred));
  assert(inferred.docsDir === repo.expected.docsDir, repo.id + " inferred wrong docsDir: " + JSON.stringify(inferred));
  assert(inferredCiCommands.length > 0, repo.id + " inference returned no native CI candidates: " + JSON.stringify(inferred));
  const requiredCi = repo.ecosystem === "typescript-pnpm"
    ? ["corepack enable", "pnpm install --frozen-lockfile"]
    : repo.ecosystem === "typescript" || repo.ecosystem === "javascript"
      ? [repo.id === "express" ? "npm install --no-package-lock" : "npm ci"]
      : repo.ecosystem === "python"
        ? ["python -m pytest"]
        : repo.ecosystem === "go"
          ? ["go test ./..."]
          : repo.ecosystem === "rust" ? ["cargo test --workspace --all-targets --locked"] : [];
  for (const command of requiredCi) assert(inferredCiCommands.includes(command), repo.id + " inference missed CI candidate " + command + ": " + JSON.stringify(inferred));
  if (repo.ecosystem === "python") {
    assert(inferredCiCommands.some((command: string) => command.startsWith("python -m pip install ")), repo.id + " Python inference missed an install candidate: " + JSON.stringify(inferred));
  }
  if (checked.status !== 0 || !existsSync(join(root, "hy-workflow.json"))) {
    const applied = await run("hy-workflow", configArgs(repo), {
      cwd: root,
      env: workspace.env,
      timeoutMs: 20_000,
      allowFailure: true,
    });
    const appliedEnvelope = parseJsonOutput(applied.stdout);
    assert(applied.status === 0 && appliedEnvelope.ok === true, repo.id + " explicit config recovery failed: " + applied.stdout);
  }
}

async function verifyArtifactDrift(workspace: AcceptanceWorkspace, root: string): Promise<void> {
  const workflow = join(root, ".github", "workflows", "hy-workflow.yml");
  appendFileSync(workflow, "\n# acceptance-owned-drift\n");
  const drifted = readFileSync(workflow, "utf8");
  const beforeUserState = isolatedUserStateFingerprint(workspace);
  const blocked = await run("hy-workflow", ["setup", "--yes", "--clients", "codex", "--json", "--language", "en"], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 30_000,
    allowFailure: true,
  });
  assert(blocked.status !== 0, "--yes must not silently overwrite team artifact drift");
  assert(readFileSync(workflow, "utf8") === drifted, "blocked artifact drift changed the workflow");
  assert(isolatedUserStateFingerprint(workspace) === beforeUserState, "blocked artifact drift changed isolated user state");

  const preview = await run("hy-workflow", ["setup", "--yes", "--clients", "codex", "--dry-run", "--json", "--language", "en"], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 30_000,
    allowFailure: true,
  });
  const previewEnvelope = parseJsonOutput(preview.stdout);
  const text = preview.stdout + preview.stderr;
  for (const field of ["changeKind", "beforeHash", "afterHash", "diff"]) {
    assert(text.includes(field), "artifact drift preview is missing " + field);
  }
  assert(readFileSync(workflow, "utf8") === drifted, "artifact drift preview changed the workflow");
  assert(isolatedUserStateFingerprint(workspace) === beforeUserState, "artifact drift preview changed isolated user state");

  const accepted = await run("hy-workflow", [
    "setup", "--yes", "--clients", "codex", "--accept-artifact-changes",
    ...exactArtifactReviewArgs(previewEnvelope, "artifact drift preview"),
    "--json", "--language", "en",
  ], { cwd: root, env: workspace.env, timeoutMs: 30_000 });
  assert(parseJsonOutput(accepted.stdout).ok === true, "explicit artifact acceptance failed");
  assert(!readFileSync(workflow, "utf8").includes("acceptance-owned-drift"), "accepted artifact sync did not restore canonical workflow");
}

function assertUnsetExternalCleanup(
  workspace: AcceptanceWorkspace,
  repo: AcceptanceRepo,
  projectId: string,
  unsetEnvelope: any,
): void {
  assert(/^[a-f0-9]{24}$/.test(projectId), repo.id + " setup returned an invalid projectId: " + projectId);
  assert(unsetEnvelope.removed === true, repo.id + " unset did not report removal of the installed deployment");
  assert(unsetEnvelope.remainingProjects === 0, repo.id + " unset left registered projects: " + JSON.stringify(unsetEnvelope));
  assert(Array.isArray(unsetEnvelope.remainingOwnedClients) && unsetEnvelope.remainingOwnedClients.length === 0, repo.id + " unset left owned global clients: " + JSON.stringify(unsetEnvelope));
  assert(!Array.isArray(unsetEnvelope.recovery) || unsetEnvelope.recovery.length === 0, repo.id + " unset returned unresolved cleanup recovery: " + JSON.stringify(unsetEnvelope.recovery));
  assert(!Array.isArray(unsetEnvelope.clients) || unsetEnvelope.clients.every((client: any) => client?.status !== "recovery_required"), repo.id + " unset left a client in recovery_required");

  const configRoot = join(workspace.env.XDG_CONFIG_HOME!, "hy-workflow");
  const stateRoot = join(workspace.env.XDG_STATE_HOME!, "hy-workflow");
  const cacheRoot = join(workspace.env.XDG_CACHE_HOME!, "hy-workflow");
  for (const [label, parent] of [
    ["config", join(configRoot, "projects")],
    ["state", join(stateRoot, "projects")],
    ["cache", join(cacheRoot, "projects")],
  ] as const) {
    const leftovers = existsSync(parent)
      ? readdirSync(parent).filter(name => name === projectId || name.startsWith(projectId + ".removing-"))
      : [];
    assert(leftovers.length === 0, repo.id + " unset left external " + label + " state: " + leftovers.join(", "));
  }
  assert(!existsSync(join(stateRoot, "setup-journal.json")), repo.id + " unset left a setup transaction journal");

  const registryFile = join(configRoot, "registry.json");
  const registry = existsSync(registryFile) ? JSON.parse(readFileSync(registryFile, "utf8")) : { projects: {} };
  const projects = registry?.projects && typeof registry.projects === "object" ? registry.projects : {};
  assert(projects[projectId] === undefined, repo.id + " unset left its registry record");
  assert(Object.keys(projects).length === 0, repo.id + " isolated acceptance registry is not empty after unset: " + Object.keys(projects).join(", "));

  const ownershipFile = join(stateRoot, "client-ownership.json");
  const ownership = existsSync(ownershipFile) ? JSON.parse(readFileSync(ownershipFile, "utf8")) : { clients: {} };
  const ownedClients = ownership?.clients && typeof ownership.clients === "object" ? ownership.clients : {};
  const ownedServers = Object.values(ownedClients).flatMap(value => value && typeof value === "object" ? Object.keys(value as Record<string, unknown>) : []);
  assert(ownedServers.length === 0, repo.id + " unset left ownership entries: " + ownedServers.join(", "));

  const targets = ["hy-workflow", "docs-gardener"];
  const clientStateFile = workspace.env.HY_ACCEPTANCE_CLIENT_STATE!;
  const clientState = existsSync(clientStateFile) ? JSON.parse(readFileSync(clientStateFile, "utf8")) : {};
  for (const [client, definitions] of Object.entries(clientState)) {
    for (const target of targets) {
      assert(!definitions || typeof definitions !== "object" || !(target in definitions), repo.id + " unset left global " + client + " definition " + target);
    }
  }

  const codexConfig = join(workspace.env.CODEX_HOME!, "config.toml");
  if (existsSync(codexConfig)) {
    const targetTables = readFileSync(codexConfig, "utf8")
      .split(/\r?\n/)
      .map(line => /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1])
      .filter((header): header is string => header !== undefined)
      .filter(header => /^mcp_servers\.(?:hy-workflow|docs-gardener|"hy-workflow"|"docs-gardener"|'hy-workflow'|'docs-gardener')(?:\.|$)/.test(header.trim()));
    assert(targetTables.length === 0, repo.id + " unset left global Codex MCP tables: " + targetTables.join(", "));
  }

  const openCodeConfig = workspace.env.OPENCODE_CONFIG!;
  if (existsSync(openCodeConfig)) {
    const document = JSON.parse(readFileSync(openCodeConfig, "utf8"));
    for (const target of targets) assert(document?.mcp?.[target] === undefined, repo.id + " unset left global OpenCode definition " + target);
  }
}

export async function runRepositoryScenario(
  workspace: AcceptanceWorkspace,
  repo: AcceptanceRepo,
  index: number,
): Promise<ScenarioResult> {
  const started = Date.now();
  const root = await clonePinned(workspace, repo);
  const gitBefore = await gitSnapshot(root, workspace.env);
  const initialRuntime = new Set([".hy", ".codex", ".opencode", ".mcp.json", "codelint.json", "doclint.json", "docs-gardener.json"].filter(name => existsSync(join(root, name))));
  const selectedClients = repo.id === "magnet" ? "codex,claude" : "all";

  if (index === 0) {
    const beforeTuiProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
    const beforeTuiUserState = isolatedUserStateFingerprint(workspace);
    const firstOutputMs = await probeTui(workspace, root);
    assert(firstOutputMs <= 1_500, "setup TUI did not render promptly: " + firstOutputMs + "ms");
    const afterTuiProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
    assert(afterTuiProject === beforeTuiProject, "cancelled TUI changed project files");
    assert(isolatedUserStateFingerprint(workspace) === beforeTuiUserState, "cancelled TUI changed isolated user state");
  }

  if (repo.id === "flask") {
    assert(!existsSync(join(root, "hy-workflow.json")), "fresh-clone acceptance unexpectedly started with hy-workflow.json");
    const beforeFreshProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
    const beforeFreshUserState = isolatedUserStateFingerprint(workspace);
    const freshPreview = await run("hy-workflow", [
      "setup", "--yes", "--clients", selectedClients, "--dry-run", "--json", "--language", "en",
    ], { cwd: root, env: workspace.env, timeoutMs: 45_000 });
    const freshPreviewEnvelope = parseJsonOutput(freshPreview.stdout);
    assert(freshPreviewEnvelope.ok === true, "fresh-clone setup preview failed");
    assert(Array.isArray(freshPreviewEnvelope.projectFilesChanged) && freshPreviewEnvelope.projectFilesChanged.sort().join(",") === ".github/workflows/hy-workflow.yml,hy-workflow.json", "fresh-clone preview did not report exactly two project artifacts");
    assert((await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout === beforeFreshProject, "fresh-clone dry-run changed project files");
    assert(isolatedUserStateFingerprint(workspace) === beforeFreshUserState, "fresh-clone dry-run changed isolated user state");
    const freshArtifactReviewArgs = freshPreviewEnvelope.artifactChanges?.some((change: any) => change?.requiresAcceptance)
      ? exactArtifactReviewArgs(freshPreviewEnvelope, "fresh-clone setup preview")
      : [];
    const freshSetup = await run("hy-workflow", [
      "setup", "--yes", "--clients", selectedClients,
      ...(freshArtifactReviewArgs.length ? ["--accept-artifact-changes", ...freshArtifactReviewArgs] : []),
      "--json", "--language", "en",
    ], { cwd: root, env: workspace.env, timeoutMs: 60_000 });
    const freshEnvelope = parseJsonOutput(freshSetup.stdout);
    assert(freshEnvelope.ok === true, "fresh-clone setup did not return ok=true");
    const freshChanged = await assertProjectBoundary(root, workspace.env);
    assert(freshChanged.sort().join(",") === ".github/workflows/hy-workflow.yml,hy-workflow.json", "fresh-clone setup must write exactly the two managed artifacts");
    assert(!existsSync(join(root, "AGENTS.md")), "fresh-clone setup must not create AGENTS.md");
  }

  await ensureProjectConfig(workspace, root, repo);

  const beforeDryProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
  const beforeDryUserState = isolatedUserStateFingerprint(workspace);
  const preview = await run("hy-workflow", [
    "setup", "--yes", "--clients", selectedClients, "--dry-run", "--json", "--language", "en",
  ], { cwd: root, env: workspace.env, timeoutMs: 30_000 });
  const previewEnvelope = parseJsonOutput(preview.stdout);
  assert(previewEnvelope.ok === true, repo.id + " setup preview failed");
  const afterDryProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
  assert(beforeDryProject === afterDryProject, repo.id + " dry-run changed project files");
  assert(beforeDryUserState === isolatedUserStateFingerprint(workspace), repo.id + " dry-run changed isolated user state");
  const artifactReviewArgs = previewEnvelope.artifactChanges?.some((change: any) => change?.requiresAcceptance)
    ? exactArtifactReviewArgs(previewEnvelope, repo.id + " setup preview")
    : [];

  const setup = await run("hy-workflow", [
    "setup", "--yes", "--clients", selectedClients,
    ...(artifactReviewArgs.length ? ["--accept-artifact-changes", ...artifactReviewArgs] : []),
    "--json", "--language", "en",
  ], { cwd: root, env: workspace.env, timeoutMs: 45_000 });
  const setupEnvelope = parseJsonOutput(setup.stdout);
  assert(setupEnvelope.ok === true, repo.id + " setup did not return ok=true");
  const changed = await assertProjectBoundary(root, workspace.env);
  assert(changed.includes("hy-workflow.json") || existsSync(join(root, "hy-workflow.json")), repo.id + " setup did not maintain hy-workflow.json");
  assert(existsSync(join(root, ".github", "workflows", "hy-workflow.yml")), repo.id + " setup did not maintain workflow");

  const beforeRepeatProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
  const beforeRepeatClients = existsSync(workspace.env.HY_ACCEPTANCE_CLIENT_STATE!)
    ? readFileSync(workspace.env.HY_ACCEPTANCE_CLIENT_STATE!, "utf8")
    : "";
  const openCodeConfig = workspace.env.OPENCODE_CONFIG!;
  const beforeRepeatOpenCode = existsSync(openCodeConfig) ? readFileSync(openCodeConfig, "utf8") : "";
  const repeated = await run("hy-workflow", [
    "setup", "--yes", "--clients", selectedClients, "--json", "--language", "en",
  ], { cwd: root, env: workspace.env, timeoutMs: 45_000 });
  assert(parseJsonOutput(repeated.stdout).ok === true, repo.id + " repeated setup failed");
  const afterRepeatProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
  assert(beforeRepeatProject === afterRepeatProject, repo.id + " repeated setup changed project files");
  const afterRepeatClients = existsSync(workspace.env.HY_ACCEPTANCE_CLIENT_STATE!)
    ? readFileSync(workspace.env.HY_ACCEPTANCE_CLIENT_STATE!, "utf8")
    : "";
  assert(beforeRepeatClients === afterRepeatClients, repo.id + " repeated setup rewrote client definitions");
  const afterRepeatOpenCode = existsSync(openCodeConfig) ? readFileSync(openCodeConfig, "utf8") : "";
  assert(beforeRepeatOpenCode === afterRepeatOpenCode, repo.id + " repeated setup rewrote OpenCode config");

  const doctor = await run("hy-workflow", ["doctor", "--offline", "--json"], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 30_000,
  });
  const doctorEnvelope = parseJsonOutput(doctor.stdout);
  assert(doctorEnvelope.ok === true, repo.id + " offline doctor failed");

  const lintPressure = await runRepositoryLintPressure(workspace, root, repo);

  const docs = await mcpDocsBaseline(workspace, root, "Update project usage and setup documentation");
  assert(docs.chars > 0 && docs.chars <= 48_000, repo.id + " docs baseline exceeded the 48k policy: " + docs.chars);
  assert(!docs.response.error, repo.id + " hy_read_docs returned an MCP error");

  if (repo.id === "docs-gardener") await verifyArtifactDrift(workspace, root);

  const unset = await run("hy-workflow", [
    "unset", "--yes", "--clients", "all", "--remove-global", "--json", "--language", "en",
  ], { cwd: root, env: workspace.env, timeoutMs: 45_000 });
  const unsetEnvelope = parseJsonOutput(unset.stdout);
  assert(unsetEnvelope.ok === true, repo.id + " unset failed");
  assert(existsSync(join(root, "hy-workflow.json")), "unset removed shared hy-workflow.json");
  assert(existsSync(join(root, ".github", "workflows", "hy-workflow.yml")), "unset removed shared workflow");
  assertUnsetExternalCleanup(workspace, repo, setupEnvelope.projectId, unsetEnvelope);

  for (const name of [".hy", ".codex", ".opencode", ".mcp.json", "codelint.json", "doclint.json", "docs-gardener.json"]) {
    if (!initialRuntime.has(name)) assert(!existsSync(join(root, name)), repo.id + " created forbidden project-local artifact " + name);
  }
  await assertProjectBoundary(root, workspace.env);
  const gitAfter = await gitSnapshot(root, workspace.env);
  assert(gitAfter.head === gitBefore.head, repo.id + " setup changed HEAD");
  assert(gitAfter.remote === gitBefore.remote, repo.id + " setup changed the remote URL");
  assert(gitAfter.refs === gitBefore.refs, repo.id + " setup changed remote refs");
  const workspaceBytes = assertWorkspaceDiskBudget(workspace);

  return {
    name: "repository-lifecycle",
    repository: repo.id,
    durationMs: Date.now() - started,
    detail: {
      commit: repo.commit,
      ecosystem: repo.ecosystem,
      changed,
      docsChars: docs.chars,
      lintPressure,
      workspaceBytes,
    },
  };
}

export async function createFixture(workspace: AcceptanceWorkspace, name: string, includeConfig = true): Promise<string> {
  const root = join(workspace.repos, name);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "index.js"), "export const value = 1;\n");
  writeFileSync(join(root, "docs", "index.md"), "# Fixture\n\nAcceptance fixture facts.\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name,
    version: "1.0.0",
    scripts: { test: "node --test" },
  }, null, 2) + "\n");
  if (includeConfig) {
    writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({
      project: { baseBranch: "main", codeExt: ".js", codeDirs: ["src"], docsDir: "docs" },
      codelint: { lintDirs: ["src"], maxLinesWarning: 300, maxLinesError: 500 },
      doclint: { maxLinesWarning: 200, maxLinesError: 500 },
      docsGardener: { catalogs: {} },
      ci: { commands: ["npm test"] },
    }, null, 2) + "\n");
  }
  await run("git", ["init", "-b", "main"], { cwd: root, env: workspace.env });
  await run("git", ["config", "user.email", "acceptance@example.invalid"], { cwd: root, env: workspace.env });
  await run("git", ["config", "user.name", "Acceptance"], { cwd: root, env: workspace.env });
  await run("git", ["remote", "add", "origin", "https://github.com/voxServalG/hy-workflow-acceptance-read-only.invalid"], { cwd: root, env: workspace.env });
  await run("git", ["add", "."], { cwd: root, env: workspace.env });
  await run("git", ["commit", "-m", "fixture"], { cwd: root, env: workspace.env });
  await run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root, env: workspace.env });
  await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: root, env: workspace.env });
  return root;
}

export async function runConcurrencyScenario(workspace: AcceptanceWorkspace): Promise<ScenarioResult> {
  const started = Date.now();
  const root = await createFixture(workspace, "concurrency", false);
  const commands = Array.from({ length: 32 }, () => run("hy-workflow", [
    "setup", "--yes", "--clients", "codex", "--json", "--language", "en",
  ], { cwd: root, env: workspace.env, timeoutMs: 90_000, allowFailure: true }));
  const results = await Promise.all(commands);
  const envelopes = results.map(result => parseJsonOutput(result.stdout + result.stderr));
  const succeeded = results.filter((result, index) => !result.timedOut && result.status === 0 && envelopes[index]?.ok === true);
  const contended = results.filter((result, index) => {
    const envelope = envelopes[index];
    return !result.timedOut
      && result.status === 1
      && envelope?.ok === false
      && envelope?.error?.code === "SETUP_LOCK_BUSY"
      && envelope?.error?.retryable === true;
  });
  const unexpected = results
    .map((result, index) => ({ result, envelope: envelopes[index] }))
    .filter(({ result }) => !succeeded.includes(result) && !contended.includes(result))
    .map(({ result, envelope }) => ({ status: result.status, timedOut: result.timedOut, envelope }));
  assert(succeeded.length > 0, "32-way setup produced no successful owner transaction");
  assert(unexpected.length === 0, "32-way setup produced unexpected failures: " + JSON.stringify(unexpected.slice(0, 3)));
  const postContention = await run("hy-workflow", [
    "setup", "--yes", "--clients", "codex", "--json", "--language", "en",
  ], { cwd: root, env: workspace.env, timeoutMs: 90_000 });
  assert(parseJsonOutput(postContention.stdout).ok === true, "setup did not recover after 32-way lock contention");
  await assertProjectBoundary(root, workspace.env);
  await run("hy-workflow", ["unset", "--yes", "--clients", "all", "--remove-global", "--json", "--language", "en"], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 60_000,
  });
  return {
    name: "concurrency-32",
    durationMs: Date.now() - started,
    detail: {
      processes: results.length,
      succeeded: succeeded.length,
      retryableContention: contended.length,
      postContentionRecovery: true,
    },
  };
}

export async function runFaultScenario(workspace: AcceptanceWorkspace): Promise<ScenarioResult> {
  const started = Date.now();
  const failpoints = [
    "client:codex:hy-workflow",
    "shared:config",
    "shared:workflow",
    "deployment",
    "registry",
    "ownership",
    "postcondition",
  ];
  for (const failpoint of failpoints) {
    const root = await createFixture(workspace, "fault-" + failpoint.replace(/[^a-z]+/g, "-"), false);
    const before = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
    const beforeUserState = isolatedUserStateFingerprint(workspace);
    const result = await run(process.execPath, [
      join(workspace.sourceRoot, "test", "acceptance", "setup-failpoint-child.mjs"),
      failpoint,
      "--yes", "--clients", "codex", "--json", "--language", "en",
    ], {
      cwd: root,
      env: workspace.env,
      timeoutMs: 45_000,
      allowFailure: true,
    });
    assert(result.status !== 0, "failpoint did not fail: " + failpoint);
    assert(
      (result.stdout + result.stderr).includes(`Injected setup failure at ${failpoint}.`),
      "failpoint failed for the wrong reason: " + failpoint + "\n" + (result.stdout + result.stderr).slice(-4_000),
    );
    const after = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
    assert(after === before, "failpoint left project changes: " + failpoint + "\n" + after);
    assert(isolatedUserStateFingerprint(workspace) === beforeUserState, "failpoint left isolated HOME or client state changes: " + failpoint);
    const doctor = await run("hy-workflow", ["doctor", "--offline", "--json"], {
      cwd: root,
      env: workspace.env,
      timeoutMs: 30_000,
      allowFailure: true,
    });
    const doctorText = doctor.stdout + doctor.stderr;
    assert(/recovery|journal|not deployed|setup/i.test(doctorText), "doctor gave no recovery evidence after " + failpoint);
  }
  return {
    name: "transaction-fault-matrix",
    durationMs: Date.now() - started,
    detail: { failpoints },
  };
}
