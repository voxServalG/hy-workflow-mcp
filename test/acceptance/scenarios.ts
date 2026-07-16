import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { AcceptanceRepo, AcceptanceWorkspace } from "./harness.js";
import { validateLintPressureEnvelope, type LintPressureSummary, type LintPressureTool } from "./lint-report.js";
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

type TestOwnedMigration = {
  file: string;
  original: string;
  migrated: string;
  injected?: boolean;
};

const MANAGED_RULES_BLOCK = /<!-- hy-workflow-rules -->[\s\S]*?<!-- \/hy-workflow-rules -->/;
const COMPAT_FILES = ["codelint.json", "doclint.json", "docs-gardener.json"] as const;
const LINT_PRESSURE_TIMEOUT_MS = 120_000;
const LINT_PREPARATION_TIMEOUT_MS = 240_000;
const LINT_PREPARATION_ATTEMPTS = 2;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function exactCiArgs(envelope: any, context: string): string[] {
  const candidates = envelope?.ciCandidates;
  assert(Array.isArray(candidates) && candidates.length > 0, context + " reported no CI candidates to review");
  assert(candidates.every((command: unknown) => typeof command === "string" && command.trim() === command && command.length > 0), context + " reported an invalid CI command");
  assert(new Set(candidates).size === candidates.length, context + " reported duplicate CI commands");
  return candidates.flatMap((command: string) => ["--ci-command", command]);
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

export async function prepareLintPressurePackages(workspace: AcceptanceWorkspace): Promise<Array<Record<string, unknown>>> {
  const prepared: Array<Record<string, unknown>> = [];
  for (const tool of ["doclint", "codelint"] as LintPressureTool[]) {
    let envelope: any = null;
    let failure = "";
    let attempts = 0;
    for (let attempt = 1; attempt <= LINT_PREPARATION_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      const result = await run(process.execPath, [
        join(workspace.sourceRoot, "test", "acceptance", "lint-pressure-child.mjs"),
        tool,
        "prepare",
      ], {
        cwd: workspace.sourceRoot,
        env: { ...workspace.env, HY_ACCEPTANCE_LINT_TIMEOUT_MS: String(LINT_PREPARATION_TIMEOUT_MS) },
        timeoutMs: LINT_PREPARATION_TIMEOUT_MS + 15_000,
        allowFailure: true,
      });
      if (!result.timedOut && result.status === 0) {
        envelope = parseJsonOutput(result.stdout);
        break;
      }
      failure = `attempt ${attempt}/${LINT_PREPARATION_ATTEMPTS}: ${(result.stderr || result.stdout).slice(-4_000)}`;
    }
    assert(envelope, tool + " immutable codeload package preparation failed: " + failure);
    assert(envelope.tool === tool && envelope.mode === "prepare" && envelope.status === 0 && envelope.timedOut === false, tool + " preparation returned invalid evidence");
    assert(typeof envelope.source === "string" && /^https:\/\/codeload\.github\.com\/voxServalG\/(?:doclint|codelint)\/tar\.gz\/[0-9a-f]{40}$/.test(envelope.source), tool + " preparation source is not an immutable codeload commit");
    assert(envelope.phase === "dependencies" && /^[0-9a-f]{128}$/.test(envelope.expectedSha512) && envelope.archiveSha512 === envelope.expectedSha512, tool + " preparation did not verify the downloaded archive SHA-512");
    assert(typeof envelope.archive === "string" && relative(workspace.root, envelope.archive).replace(/\\/g, "/").startsWith("lint-archives/"), tool + " preparation escaped the isolated archive directory");
    assert(Number.isFinite(envelope.durationMs) && envelope.durationMs >= 0 && envelope.durationMs <= LINT_PREPARATION_TIMEOUT_MS, tool + " preparation exceeded its network budget");
    prepared.push({ tool, source: envelope.source, sha512: envelope.archiveSha512, attempts, durationMs: envelope.durationMs });
  }
  return prepared;
}

async function runRepositoryLintPressure(
  workspace: AcceptanceWorkspace,
  root: string,
  repo: AcceptanceRepo,
): Promise<LintPressureSummary[]> {
  const summaries: LintPressureSummary[] = [];
  for (const tool of ["doclint", "codelint"] as LintPressureTool[]) {
    const before = compatibilitySnapshot(root);
    const result = await run(process.execPath, [
      join(workspace.sourceRoot, "test", "acceptance", "lint-pressure-child.mjs"),
      tool,
      "scan",
    ], {
      cwd: root,
      env: { ...workspace.env, HY_ACCEPTANCE_LINT_TIMEOUT_MS: String(LINT_PRESSURE_TIMEOUT_MS) },
      timeoutMs: LINT_PRESSURE_TIMEOUT_MS + 15_000,
      allowFailure: true,
    });
    assertCompatibilityUnchanged(root, before, repo.id + " " + tool);
    assert(!result.timedOut, repo.id + " " + tool + " child exceeded the outer timeout");
    assert(result.status === 0, repo.id + " " + tool + " child crashed: " + (result.stderr || result.stdout).slice(-4_000));
    const envelope = parseJsonOutput(result.stdout);
    const summary = validateLintPressureEnvelope(envelope, tool, repo.category === "legacy", LINT_PRESSURE_TIMEOUT_MS);
    if (tool === "codelint") {
      const supported = repo.ecosystem === "python" || repo.ecosystem === "rust";
      assert(summary.notApplicable === !supported, repo.id + " codelint applicability drifted from the pinned Python/Rust support matrix");
      assert(summary.projectFiles > 0, repo.id + " installed project profile found no actual configured code files");
      if (supported) assert(summary.files > 0 && summary.supportedFiles > 0, repo.id + " codelint did not scan supported code");
      else assert(summary.files === 0 && summary.supportedFiles === 0, repo.id + " unsupported codelint target was not an honest N/A");
    }
    summaries.push(summary);
  }
  return summaries;
}

function isolatedUserStateFingerprint(workspace: AcceptanceWorkspace): string {
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

async function verifyStaleManagedAgentsAutoMigration(workspace: AcceptanceWorkspace, root: string, repo: AcceptanceRepo): Promise<{ original: string; file: string }> {
  const file = join(root, "AGENTS.md");
  assert(existsSync(file), repo.id + " legacy fixture has no AGENTS.md to auto-migrate");
  const beforeProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
  const beforeUserState = isolatedUserStateFingerprint(workspace);
  const original = readFileSync(file, "utf8");
  assert(MANAGED_RULES_BLOCK.test(original), repo.id + " legacy AGENTS.md has no managed rules block to migrate");
  const dryRun = await run("hy-workflow", ["setup", "--yes", "--clients", "codex", "--dry-run", "--json", "--language", "en"], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 30_000,
    allowFailure: true,
  });
  const output = dryRun.stdout + dryRun.stderr;
  assert(dryRun.status === 0, repo.id + " dry-run with stale AGENTS must not block setup: " + output);
  const envelope = parseJsonOutput(dryRun.stdout);
  assert(envelope.ok === true, repo.id + " dry-run envelope must be ok for stale AGENTS auto-migration");
  assert(Array.isArray(envelope.artifactChanges), repo.id + " dry-run must expose artifact changes");
  assert(envelope.artifactChanges.some((item: any) => item.file === "AGENTS.md"), repo.id + " dry-run must report AGENTS.md managed_update");
  assert((await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout === beforeProject, repo.id + " dry-run must not modify project files");
  assert(isolatedUserStateFingerprint(workspace) === beforeUserState, repo.id + " dry-run must not modify isolated user state");
  return { original, file };
}

function isTargetCodexTable(header: string): boolean {
  return ["hy-workflow", "docs-gardener"].some(server => {
    const escaped = server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^mcp_servers\\.(?:${escaped}|"${escaped}"|'${escaped}')(?:\\.|$)`).test(header.trim());
  });
}

function ensureLegacyCodexFixture(root: string): boolean {
  const file = join(root, ".codex", "config.toml");
  if (existsSync(file)) return false;
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(file, [
    "# acceptance-owned local legacy MCP fixture",
    "[mcp_servers.hy-workflow]",
    'command = "npx"',
    'args = ["-y", "git+https://github.com/voxServalG/hy-workflow-mcp.git#main"]',
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 300",
    "",
    "[mcp_servers.docs-gardener]",
    'command = "npx"',
    'args = ["-y", "git+https://github.com/voxServalG/docs-gardener.git", "mcp"]',
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 300",
    "",
    "[unrelated]",
    'preserve = "yes"',
    "",
  ].join("\n"));
  return true;
}

async function verifyCodexProjectShadowBoundary(workspace: AcceptanceWorkspace, root: string, repo: AcceptanceRepo): Promise<void> {
  const beforeProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
  const beforeUserState = isolatedUserStateFingerprint(workspace);
  const result = await run("hy-workflow", ["setup", "--yes", "--clients", "codex", "--dry-run", "--json", "--language", "en"], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 30_000,
    allowFailure: true,
  });
  const output = result.stdout + result.stderr;
  assert(result.status !== 0, repo.id + " project-level Codex MCP definition must block setup");
  assert(/client_shadowed|shadowed|\.codex\/config\.toml/i.test(output), repo.id + " Codex shadow result did not name the project config boundary");
  const afterProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
  assert(afterProject === beforeProject, repo.id + " blocked Codex shadow preflight changed project files");
  assert(isolatedUserStateFingerprint(workspace) === beforeUserState, repo.id + " blocked Codex shadow preflight changed isolated user state");
}

function migrateCodexProjectSectionsExplicitly(root: string, repo: AcceptanceRepo): TestOwnedMigration {
  const file = join(root, ".codex", "config.toml");
  assert(existsSync(file), repo.id + " legacy fixture has no .codex/config.toml to migrate");
  const original = readFileSync(file, "utf8");
  const lines = original.match(/.*(?:\r?\n|$)/g)?.filter(line => line.length > 0) ?? [];
  let skip = false;
  let removed = 0;
  const kept: string[] = [];
  const unrelatedHeaders: string[] = [];
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?(?:\r?\n)?$/.exec(line)?.[1];
    if (header !== undefined) {
      skip = isTargetCodexTable(header);
      if (skip) removed += 1;
      else unrelatedHeaders.push(line.trim());
    }
    if (!skip) kept.push(line);
  }
  assert(removed > 0, repo.id + " legacy Codex config contains no target MCP section");
  const migrated = kept.join("");
  for (const header of unrelatedHeaders) assert(migrated.includes(header), repo.id + " Codex migration dropped unrelated table " + header);
  writeFileSync(file, migrated);
  return { file, original, migrated };
}

async function verifyLegacyShadowBoundary(workspace: AcceptanceWorkspace, root: string): Promise<void> {
  const beforeProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
  const beforeUserState = isolatedUserStateFingerprint(workspace);
  const result = await run("hy-workflow", ["setup", "--yes", "--clients", "all", "--dry-run", "--json", "--language", "en"], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 30_000,
    allowFailure: true,
  });
  const afterProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
  assert(result.status !== 0, "legacy project-level OpenCode shadow must block setup");
  assert(/shadow|migration_required|\.opencode\/opencode\.json/i.test(result.stdout + result.stderr), "shadow result must name the migration boundary");
  assert(beforeProject === afterProject, "blocked legacy migration changed the project");
  assert(beforeUserState === isolatedUserStateFingerprint(workspace), "dry-run/blocked migration changed isolated user state");
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
      .filter((header): header is string => header !== undefined && isTargetCodexTable(header));
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
    assert(freshPreviewEnvelope.ok === true && freshPreviewEnvelope.ciConfirmationRequired === true, "fresh-clone setup preview did not infer a confirmable install");
    assert(Array.isArray(freshPreviewEnvelope.projectFilesChanged) && freshPreviewEnvelope.projectFilesChanged.sort().join(",") === ".github/workflows/hy-workflow.yml,hy-workflow.json", "fresh-clone preview did not report exactly two project artifacts");
    assert((await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout === beforeFreshProject, "fresh-clone dry-run changed project files");
    assert(isolatedUserStateFingerprint(workspace) === beforeFreshUserState, "fresh-clone dry-run changed isolated user state");
    const freshCiArgs = exactCiArgs(freshPreviewEnvelope, "fresh-clone setup preview");
    const freshSetup = await run("hy-workflow", [
      "setup", "--yes", "--clients", selectedClients, "--accept-ci-commands", ...freshCiArgs, "--json", "--language", "en",
    ], { cwd: root, env: workspace.env, timeoutMs: 60_000 });
    const freshEnvelope = parseJsonOutput(freshSetup.stdout);
    assert(freshEnvelope.ok === true, "fresh-clone setup did not return ok=true");
    const freshChanged = await assertProjectBoundary(root, workspace.env);
    assert(freshChanged.includes("hy-workflow.json") && freshChanged.includes(".github/workflows/hy-workflow.yml") && freshChanged.includes("AGENTS.md"), "fresh-clone setup must write the three managed artifacts");
  }

  await ensureProjectConfig(workspace, root, repo);
  let managedAgentsOriginal: { original: string; file: string } | null = null;
  let codexProjectMigration: TestOwnedMigration | null = null;
  if (repo.category === "legacy") {
    managedAgentsOriginal = await verifyStaleManagedAgentsAutoMigration(workspace, root, repo);
    const injectedCodexFixture = ensureLegacyCodexFixture(root);
    await verifyCodexProjectShadowBoundary(workspace, root, repo);
    codexProjectMigration = migrateCodexProjectSectionsExplicitly(root, repo);
    codexProjectMigration.injected = injectedCodexFixture;
  }
  if (repo.id === "magnet") await verifyLegacyShadowBoundary(workspace, root);

  const beforeDryProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
  const beforeDryUserState = isolatedUserStateFingerprint(workspace);
  const preview = await run("hy-workflow", [
    "setup", "--yes", "--clients", selectedClients, "--dry-run", "--json", "--language", "en",
  ], { cwd: root, env: workspace.env, timeoutMs: 30_000 });
  const previewEnvelope = parseJsonOutput(preview.stdout);
  assert(previewEnvelope.ok === true, repo.id + " setup preview failed");
  assert(previewEnvelope.ciConfirmationRequired === (repo.id !== "flask"), repo.id + " setup preview reported the wrong CI confirmation state");
  assert(Array.isArray(previewEnvelope.ciCandidates) && previewEnvelope.ciCandidates.length > 0, repo.id + " setup detected no native CI command candidates");
  const afterDryProject = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
  assert(beforeDryProject === afterDryProject, repo.id + " dry-run changed project files");
  assert(beforeDryUserState === isolatedUserStateFingerprint(workspace), repo.id + " dry-run changed isolated user state");
  const ciArgs = exactCiArgs(previewEnvelope, repo.id + " setup preview");
  let artifactReviewArgs: string[] = [];
  if (previewEnvelope.ciConfirmationRequired) {
    const exactPreview = await run("hy-workflow", [
      "setup", "--yes", "--clients", selectedClients, "--accept-ci-commands", ...ciArgs,
      "--dry-run", "--json", "--language", "en",
    ], { cwd: root, env: workspace.env, timeoutMs: 30_000 });
    const exactPreviewEnvelope = parseJsonOutput(exactPreview.stdout);
    assert(exactPreviewEnvelope.ok === true && exactPreviewEnvelope.ciConfirmationRequired === false, repo.id + " exact-command preview failed");
    artifactReviewArgs = exactArtifactReviewArgs(exactPreviewEnvelope, repo.id + " exact-command preview");
    assert(beforeDryProject === (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout, repo.id + " exact-command preview changed project files");
    assert(beforeDryUserState === isolatedUserStateFingerprint(workspace), repo.id + " exact-command preview changed isolated user state");
  }

  if (repo.category === "legacy") {
    const blocked = await run("hy-workflow", [
      "setup", "--yes", "--clients", selectedClients, "--accept-ci-commands", ...ciArgs, "--json", "--language", "en",
    ], { cwd: root, env: workspace.env, timeoutMs: 30_000, allowFailure: true });
    assert(blocked.status !== 0, repo.id + " --yes silently accepted an existing team artifact overwrite");
    assert(/artifact|accept-artifact-changes|drift/i.test(blocked.stdout + blocked.stderr), repo.id + " blocked overwrite did not explain explicit artifact acceptance");
    assert(beforeDryProject === (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout, repo.id + " blocked overwrite changed project files");
    assert(beforeDryUserState === isolatedUserStateFingerprint(workspace), repo.id + " blocked overwrite changed isolated user state");
  }

  const setup = await run("hy-workflow", [
    "setup", "--yes", "--clients", selectedClients, "--accept-ci-commands", ...ciArgs,
    ...(artifactReviewArgs.length ? ["--accept-artifact-changes", ...artifactReviewArgs] : []),
    "--json", "--language", "en",
  ], { cwd: root, env: workspace.env, timeoutMs: 45_000 });
  const setupEnvelope = parseJsonOutput(setup.stdout);
  assert(setupEnvelope.ok === true, repo.id + " setup did not return ok=true");
  const testOwnedFiles = [codexProjectMigration ? ".codex/config.toml" : null]
    .filter((file): file is string => file !== null);
  const changed = await assertProjectBoundary(root, workspace.env, ["AGENTS.md", ...testOwnedFiles]);
  assert(changed.includes("hy-workflow.json") || existsSync(join(root, "hy-workflow.json")), repo.id + " setup did not maintain hy-workflow.json");
  assert(existsSync(join(root, ".github", "workflows", "hy-workflow.yml")), repo.id + " setup did not maintain workflow");
  if (repo.category === "legacy") {
    assert(changed.includes("AGENTS.md"), repo.id + " setup must auto-migrate stale AGENTS.md");
    const migrated = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert(MANAGED_RULES_BLOCK.test(migrated), repo.id + " auto-migrated AGENTS.md must contain a canonical managed block");
    const block = migrated.match(MANAGED_RULES_BLOCK)?.[0] ?? "";
    assert(block.includes("hy-workflow-rules-version:"), repo.id + " auto-migrated block must carry a version marker");
  const exported = await run("hy-workflow", ["config", "--print-managed-rules"], { cwd: root, env: workspace.env, timeoutMs: 20_000 });
  assert(exported.status === 0 && /<!--\s*hy-workflow-rules-version:/.test(exported.stdout), repo.id + " installed package must still export canonical managed rules for offline reference");
  }

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

  if (managedAgentsOriginal) {
    writeFileSync(managedAgentsOriginal.file, managedAgentsOriginal.original);
  }
  if (codexProjectMigration) {
    assert(readFileSync(codexProjectMigration.file, "utf8") === codexProjectMigration.migrated, repo.id + " setup or unset modified project .codex/config.toml after explicit human migration");
    if (codexProjectMigration.injected) rmSync(join(root, ".codex"), { recursive: true, force: true });
    else writeFileSync(codexProjectMigration.file, codexProjectMigration.original);
  }

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
      managedAgentsAutoMigration: Boolean(managedAgentsOriginal),
      codexProjectMigration: Boolean(codexProjectMigration),
      workspaceBytes,
    },
  };
}

async function createFixture(workspace: AcceptanceWorkspace, name: string, includeConfig = true): Promise<string> {
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
      codelint: { lintDirs: ["src"], maxLines: 500 },
      doclint: { maxLines: 200 },
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
  const root = await createFixture(workspace, "concurrency");
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
      "--yes", "--clients", "codex", "--json", "--language", "en", "--ci-command", "npm test",
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
