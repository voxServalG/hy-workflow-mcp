import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GhCapability = "available" | "unavailable";
export type GhViewMode = "available" | "unavailable" | "unavailable-after-merge";
export type GhMergeExit = "success" | "remote-success-error";
export type PrState = "OPEN" | "MERGED" | "CLOSED";
export type GitFaultOperation = "checkout" | "pull" | "rebase" | "push" | "fetch" | "rev-parse";

export type PrIdentityOverride = {
  baseBranch?: string;
  headBranch?: string;
  headOid?: string;
  isCrossRepository?: boolean;
};

export type GitGhHarness = {
  root: string;
  bare: string;
  runtimeHome: string;
  baseBranch: string;
  sourceBranch: string;
  downstreamBranches: string[];
  prNumber: number;
  repository: string;
  baseOid: string;
  verifiedOid: string;
  setGhCapability(value: GhCapability): void;
  setGhViewMode(value: GhViewMode): void;
  setGhMergeExit(value: GhMergeExit): void;
  setPrState(value: PrState): void;
  setPrIdentity(value?: PrIdentityOverride): void;
  integrateRemote(): void;
  advanceRemoteBase(): string;
  divergeBranch(branch: string): { localOid: string; remoteOid: string };
  createUnrelatedAgentBranch(branch: string): { localOid: string; remoteOid: string };
  failGitOnce(operation: GitFaultOperation, target?: string): void;
  clearGitFault(): void;
  ghCalls(prefix?: string): string[];
  gitCalls(prefix?: string): string[];
  localOid(branch: string): string | null;
  remoteOid(branch: string): string | null;
  deleteRemoteBranch(branch: string): void;
  remoteContains(branch: string, oid: string): boolean;
  forceRemoteBranch(branch: string, oid: string): void;
  cleanup(): void;
};

const ENV_KEYS = [
  "HY_WORKFLOW_CONFIG_HOME",
  "HY_WORKFLOW_STATE_HOME",
  "HY_WORKFLOW_CACHE_HOME",
  "HY_TEST_REAL_GIT",
  "HY_TEST_BARE_ORIGIN",
  "HY_TEST_ADMIN_CLONE",
  "HY_TEST_GH_LOG",
  "HY_TEST_GIT_LOG",
  "HY_TEST_PR_STATE_FILE",
  "HY_TEST_GIT_FAULT_MARKER",
  "HY_TEST_GIT_FAIL_OPERATION",
  "HY_TEST_GIT_FAIL_TARGET",
  "HY_TEST_GH_CAPABILITY",
  "HY_TEST_GH_VIEW_MODE",
  "HY_TEST_GH_MERGE_EXIT",
  "HY_TEST_PR_NUMBER",
  "HY_TEST_PR_BASE",
  "HY_TEST_PR_HEAD",
  "HY_TEST_PR_OID",
  "HY_TEST_PR_CROSS_REPOSITORY",
] as const;

function runGit(realGit: string, root: string, args: string[], options: Partial<ExecFileSyncOptionsWithStringEncoding> = {}): string {
  return execFileSync(realGit, args, {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function lines(file: string, prefix?: string): string[] {
  if (!existsSync(file)) return [];
  const values = readFileSync(file, "utf-8").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  return prefix ? values.filter(value => value.startsWith(prefix)) : values;
}

function installGhShim(target: string): void {
  writeFileSync(target, `#!/bin/bash
set -u
printf '%s\\n' "$*" >> "$HY_TEST_GH_LOG"
if [ "$1" = "--version" ]; then
  printf 'gh version merge-recovery-test\\n'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ "$HY_TEST_GH_CAPABILITY" = "available" ]; then exit 0; fi
  printf 'gh authentication unavailable\\n' >&2
  exit 77
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  state="$(tr -d '\\r\\n' < "$HY_TEST_PR_STATE_FILE")"
  if [ "$HY_TEST_GH_VIEW_MODE" = "unavailable" ] || { [ "$HY_TEST_GH_VIEW_MODE" = "unavailable-after-merge" ] && [ "$state" = "MERGED" ]; }; then
    printf 'GitHub query unavailable\\n' >&2
    exit 75
  fi
  printf '{"state":"%s","baseRefName":"%s","headRefName":"%s","headRefOid":"%s","isCrossRepository":%s}' \
    "$state" "$HY_TEST_PR_BASE" "$HY_TEST_PR_HEAD" "$HY_TEST_PR_OID" "$HY_TEST_PR_CROSS_REPOSITORY"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  "$HY_TEST_REAL_GIT" -C "$HY_TEST_ADMIN_CLONE" fetch origin "$HY_TEST_PR_BASE" "$HY_TEST_PR_HEAD" >/dev/null 2>&1
  "$HY_TEST_REAL_GIT" -C "$HY_TEST_ADMIN_CLONE" checkout -B "$HY_TEST_PR_BASE" "origin/$HY_TEST_PR_BASE" >/dev/null 2>&1
  "$HY_TEST_REAL_GIT" -C "$HY_TEST_ADMIN_CLONE" merge --no-ff --no-edit "$HY_TEST_PR_OID" >/dev/null 2>&1
  "$HY_TEST_REAL_GIT" -C "$HY_TEST_ADMIN_CLONE" push origin "$HY_TEST_PR_BASE" >/dev/null 2>&1
  "$HY_TEST_REAL_GIT" --git-dir="$HY_TEST_BARE_ORIGIN" update-ref -d "refs/heads/$HY_TEST_PR_HEAD"
  printf 'MERGED\\n' > "$HY_TEST_PR_STATE_FILE"
  if [ "$HY_TEST_GH_MERGE_EXIT" = "remote-success-error" ]; then
    printf 'remote accepted merge before transport timeout\\n' >&2
    exit 75
  fi
  exit 0
fi
printf 'unsupported fake gh command: %s\\n' "$*" >&2
exit 64
`, "utf-8");
  chmodSync(target, 0o755);
}

function installGitShim(target: string): void {
  writeFileSync(target, `#!/bin/bash
set -u
printf '%s\\n' "$*" >> "$HY_TEST_GIT_LOG"
if [ "$HY_TEST_GIT_FAIL_OPERATION" != "none" ] && [ "$1" = "$HY_TEST_GIT_FAIL_OPERATION" ] && { [ "$1" != "rebase" ] || [ "\${2:-}" != "--abort" ]; } && [[ "$*" == *"$HY_TEST_GIT_FAIL_TARGET"* ]] && [ ! -f "$HY_TEST_GIT_FAULT_MARKER" ]; then
  : > "$HY_TEST_GIT_FAULT_MARKER"
  printf 'injected one-shot git %s failure\\n' "$HY_TEST_GIT_FAIL_OPERATION" >&2
  exit 74
fi
if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then
  printf 'https://github.com/o/r.git\\n'
  exit 0
fi
if [ "$1" = "pull" ] && [ "$2" = "origin" ]; then
  "$HY_TEST_REAL_GIT" fetch --no-tags "$HY_TEST_BARE_ORIGIN" "refs/heads/$3:refs/remotes/origin/$3" &&
    exec "$HY_TEST_REAL_GIT" merge --ff-only "refs/remotes/origin/$3"
fi
if [ "$1" = "fetch" ] || [ "$1" = "push" ] || [ "$1" = "ls-remote" ]; then
  rewritten=()
  for argument in "$@"; do
    if [ "$argument" = "origin" ]; then rewritten+=("$HY_TEST_BARE_ORIGIN"); else rewritten+=("$argument"); fi
  done
  exec "$HY_TEST_REAL_GIT" "\${rewritten[@]}"
fi
exec "$HY_TEST_REAL_GIT" "$@"
`, "utf-8");
  chmodSync(target, 0o755);
}

export function createGitGhHarness(name = "merge-recovery", parentDirectory?: string): GitGhHarness {
  const realGit = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
  const rootParent = mkdtempSync(join(parentDirectory ?? tmpdir(), `hy-${name}-`));
  const root = join(rootParent, "work");
  const bare = join(rootParent, "origin.git");
  const admin = join(rootParent, "admin");
  const bin = join(rootParent, "bin");
  const runtimeHome = join(rootParent, "runtime");
  const ghLog = join(rootParent, "gh.log");
  const gitLog = join(rootParent, "git.log");
  const prStateFile = join(rootParent, "pr-state");
  const faultMarker = join(rootParent, "git-fault");
  const originalPath = process.env.PATH;
  const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map(key => [key, process.env[key]]));

  mkdirSync(root);
  mkdirSync(bin);
  mkdirSync(runtimeHome);
  runGit(realGit, root, ["init", "-b", "main"]);
  runGit(realGit, root, ["config", "user.email", "merge-recovery@example.invalid"]);
  runGit(realGit, root, ["config", "user.name", "Merge Recovery"]);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n", "utf-8");
  writeFileSync(join(root, "docs", "index.md"), "# Merge recovery\n", "utf-8");
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"] },
    doclint: { maxLines: 200 },
    docsGardener: { catalogs: {} },
  }, null, 2) + "\n", "utf-8");
  runGit(realGit, root, ["add", "."]);
  runGit(realGit, root, ["commit", "-m", "base"]);
  const baseOid = runGit(realGit, root, ["rev-parse", "HEAD"]);

  runGit(realGit, rootParent, ["init", "--bare", bare]);
  runGit(realGit, bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  runGit(realGit, root, ["remote", "add", "origin", bare]);
  runGit(realGit, root, ["push", "-u", "origin", "main"]);

  const sourceBranch = "feat/merge-recovery";
  runGit(realGit, root, ["checkout", "-b", sourceBranch]);
  writeFileSync(join(root, "src", "app.ts"), "export const value = 2;\n", "utf-8");
  runGit(realGit, root, ["add", "src/app.ts"]);
  runGit(realGit, root, ["commit", "-m", "verified change"]);
  const verifiedOid = runGit(realGit, root, ["rev-parse", "HEAD"]);
  runGit(realGit, root, ["push", "-u", "origin", sourceBranch]);

  const downstreamBranches = ["feat/downstream-a", "feat/downstream-b"];
  for (const [index, branch] of downstreamBranches.entries()) {
    runGit(realGit, root, ["checkout", "-b", branch, verifiedOid]);
    const file = join(root, "src", `downstream-${index + 1}.ts`);
    writeFileSync(file, `export const downstream${index + 1} = true;\n`, "utf-8");
    runGit(realGit, root, ["add", file]);
    runGit(realGit, root, ["commit", "-m", `add downstream ${index + 1}`]);
    runGit(realGit, root, ["push", "-u", "origin", branch]);
  }
  runGit(realGit, root, ["checkout", sourceBranch]);
  runGit(realGit, rootParent, ["clone", bare, admin]);
  runGit(realGit, admin, ["config", "user.email", "merge-recovery@example.invalid"]);
  runGit(realGit, admin, ["config", "user.name", "Merge Recovery"]);
  runGit(realGit, root, ["remote", "set-url", "origin", "https://github.com/o/r.git"]);

  writeFileSync(ghLog, "", "utf-8");
  writeFileSync(gitLog, "", "utf-8");
  writeFileSync(prStateFile, "OPEN\n", "utf-8");
  installGhShim(join(bin, "gh"));
  installGitShim(join(bin, "git"));

  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.HY_WORKFLOW_CONFIG_HOME = join(runtimeHome, "config");
  process.env.HY_WORKFLOW_STATE_HOME = join(runtimeHome, "state");
  process.env.HY_WORKFLOW_CACHE_HOME = join(runtimeHome, "cache");
  process.env.HY_TEST_REAL_GIT = realGit;
  process.env.HY_TEST_BARE_ORIGIN = bare;
  process.env.HY_TEST_ADMIN_CLONE = admin;
  process.env.HY_TEST_GH_LOG = ghLog;
  process.env.HY_TEST_GIT_LOG = gitLog;
  process.env.HY_TEST_PR_STATE_FILE = prStateFile;
  process.env.HY_TEST_GIT_FAULT_MARKER = faultMarker;
  process.env.HY_TEST_GIT_FAIL_OPERATION = "none";
  process.env.HY_TEST_GIT_FAIL_TARGET = "";
  process.env.HY_TEST_GH_CAPABILITY = "available";
  process.env.HY_TEST_GH_VIEW_MODE = "available";
  process.env.HY_TEST_GH_MERGE_EXIT = "success";
  process.env.HY_TEST_PR_NUMBER = "901";
  process.env.HY_TEST_PR_BASE = "main";
  process.env.HY_TEST_PR_HEAD = sourceBranch;
  process.env.HY_TEST_PR_OID = verifiedOid;
  process.env.HY_TEST_PR_CROSS_REPOSITORY = "false";

  return {
    root,
    bare,
    runtimeHome,
    baseBranch: "main",
    sourceBranch,
    downstreamBranches,
    prNumber: 901,
    repository: "github.com/o/r",
    baseOid,
    verifiedOid,
    setGhCapability(value) {
      process.env.HY_TEST_GH_CAPABILITY = value;
    },
    setGhViewMode(value) {
      process.env.HY_TEST_GH_VIEW_MODE = value;
    },
    setGhMergeExit(value) {
      process.env.HY_TEST_GH_MERGE_EXIT = value;
    },
    setPrState(value) {
      writeFileSync(prStateFile, `${value}\n`, "utf-8");
    },
    setPrIdentity(value = {}) {
      process.env.HY_TEST_PR_BASE = value.baseBranch ?? "main";
      process.env.HY_TEST_PR_HEAD = value.headBranch ?? sourceBranch;
      process.env.HY_TEST_PR_OID = value.headOid ?? verifiedOid;
      process.env.HY_TEST_PR_CROSS_REPOSITORY = String(value.isCrossRepository ?? false);
    },
    integrateRemote() {
      runGit(realGit, admin, ["fetch", "origin", "main", sourceBranch]);
      runGit(realGit, admin, ["checkout", "-B", "main", "origin/main"]);
      runGit(realGit, admin, ["merge", "--no-ff", "--no-edit", verifiedOid]);
      runGit(realGit, admin, ["push", "origin", "main"]);
      runGit(realGit, bare, ["update-ref", "-d", `refs/heads/${sourceBranch}`]);
      writeFileSync(prStateFile, "MERGED\n", "utf-8");
    },
    advanceRemoteBase() {
      runGit(realGit, admin, ["fetch", "origin", "main"]);
      runGit(realGit, admin, ["checkout", "-B", "main", "origin/main"]);
      writeFileSync(join(admin, "base-advance.txt"), "remote base advanced independently\n", "utf-8");
      runGit(realGit, admin, ["add", "base-advance.txt"]);
      runGit(realGit, admin, ["commit", "-m", "advance remote base"]);
      runGit(realGit, admin, ["push", "origin", "main"]);
      const headOid = runGit(realGit, admin, ["rev-parse", "HEAD"]);
      const remoteOid = runGit(realGit, bare, ["rev-parse", "refs/heads/main"]);
      if (headOid !== remoteOid) throw new Error(`advanced base did not reach origin: local=${headOid} remote=${remoteOid}`);
      return remoteOid;
    },
    divergeBranch(branch) {
      const originalBranch = runGit(realGit, root, ["branch", "--show-current"]);
      runGit(realGit, admin, ["fetch", "origin", branch]);
      runGit(realGit, admin, ["checkout", "-B", branch, `origin/${branch}`]);
      const suffix = branch.replaceAll("/", "-");
      writeFileSync(join(admin, `remote-${suffix}.txt`), "remote divergence\n", "utf-8");
      runGit(realGit, admin, ["add", `remote-${suffix}.txt`]);
      runGit(realGit, admin, ["commit", "-m", `diverge remote ${branch}`]);
      runGit(realGit, admin, ["push", "origin", branch]);
      const remoteOid = runGit(realGit, bare, ["rev-parse", `refs/heads/${branch}`]);
      runGit(realGit, root, ["checkout", branch]);
      writeFileSync(join(root, `local-${suffix}.txt`), "local divergence\n", "utf-8");
      runGit(realGit, root, ["add", `local-${suffix}.txt`]);
      runGit(realGit, root, ["commit", "-m", `diverge local ${branch}`]);
      const localOid = runGit(realGit, root, ["rev-parse", "HEAD"]);
      runGit(realGit, root, ["checkout", originalBranch]);
      return { localOid, remoteOid };
    },
    createUnrelatedAgentBranch(branch) {
      const tree = runGit(realGit, root, ["rev-parse", `${verifiedOid}^{tree}`]);
      const unrelatedOid = runGit(realGit, root, ["commit-tree", tree, "-m", `unrelated ${branch}`]);
      runGit(realGit, root, ["branch", branch, unrelatedOid]);
      runGit(realGit, root, ["push", bare, `${unrelatedOid}:refs/heads/${branch}`]);
      return { localOid: unrelatedOid, remoteOid: unrelatedOid };
    },
    failGitOnce(operation, target = "") {
      rmSync(faultMarker, { force: true });
      process.env.HY_TEST_GIT_FAIL_OPERATION = operation;
      process.env.HY_TEST_GIT_FAIL_TARGET = target;
    },
    clearGitFault() {
      rmSync(faultMarker, { force: true });
      process.env.HY_TEST_GIT_FAIL_OPERATION = "none";
      process.env.HY_TEST_GIT_FAIL_TARGET = "";
    },
    ghCalls(prefix) {
      return lines(ghLog, prefix);
    },
    gitCalls(prefix) {
      return lines(gitLog, prefix);
    },
    localOid(branch) {
      try {
        return runGit(realGit, root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
      } catch {
        return null;
      }
    },
    remoteOid(branch) {
      try {
        return runGit(realGit, bare, ["rev-parse", "--verify", `refs/heads/${branch}`]);
      } catch {
        return null;
      }
    },
    deleteRemoteBranch(branch) {
      runGit(realGit, bare, ["update-ref", "-d", `refs/heads/${branch}`]);
    },
    remoteContains(branch, oid) {
      try {
        execFileSync(realGit, ["merge-base", "--is-ancestor", oid, `refs/heads/${branch}`], {
          cwd: bare,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    },
    forceRemoteBranch(branch, oid) {
      runGit(realGit, bare, ["update-ref", `refs/heads/${branch}`, oid]);
    },
    cleanup() {
      process.env.PATH = originalPath;
      for (const key of ENV_KEYS) {
        const previous = originalEnv.get(key);
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
      rmSync(rootParent, { recursive: true, force: true });
    },
  };
}
