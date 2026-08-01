import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { stableJsonStringify } from "../cli/input.js";
import { HyWorkflowError } from "../cli/output.js";
import { runGit } from "./repository.js";

export type GitChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "unmerged"
  | "untracked"
  | "unknown";

export type GitChange = {
  status: GitChangeStatus;
  paths: string[];
};

export type GitSnapshot = {
  root: string;
  head: string;
  diffHash: string;
  changes: GitChange[];
  changedPaths: string[];
};

type UntrackedEntry = {
  path: string;
  mode: "100644" | "100755" | "120000";
  size: number;
  sha256: string;
};

const STATUS_NAMES: Record<string, GitChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type_changed",
  U: "unmerged",
};

function splitNull(buffer: Buffer): string[] {
  const text = buffer.toString("utf8");
  if (text.includes("\uFFFD")) {
    throw new HyWorkflowError("GIT_PATH_ENCODING_UNSUPPORTED", "Git contains a path that is not valid UTF-8.");
  }
  const values = text.split("\0");
  if (values.at(-1) === "") values.pop();
  return values;
}
function parseNameStatus(buffer: Buffer): GitChange[] {
  const fields = splitNull(buffer);
  const changes: GitChange[] = [];
  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++];
    const code = rawStatus[0] ?? "";
    const status = STATUS_NAMES[code] ?? "unknown";
    const count = code === "R" || code === "C" ? 2 : 1;
    const paths = fields.slice(index, index + count);
    if (paths.length !== count || paths.some(item => !item)) {
      throw new HyWorkflowError("GIT_DIFF_INVALID", "Git returned an incomplete changed-path record.");
    }
    index += count;
    changes.push({ status, paths });
  }
  return changes;
}

function normalizeGitPath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new HyWorkflowError("GIT_PATH_UNSAFE", "Git returned an unsafe changed path.");
  }
  const posix = relativePath.replaceAll("\\", "/");
  const absolute = path.resolve(root, ...posix.split("/"));
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HyWorkflowError("GIT_PATH_UNSAFE", `Git path escapes the worktree: ${relativePath}`);
  }
  return relative.split(path.sep).join("/");
}

function hashRegularFile(file: string, expected: fs.Stats): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY);
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(descriptor);
    if (after.dev !== expected.dev || after.ino !== expected.ino || after.size !== expected.size
      || after.mtimeMs !== expected.mtimeMs || after.mode !== expected.mode) {
      throw new HyWorkflowError("GIT_SNAPSHOT_UNSTABLE", "An untracked file changed while it was hashed.");
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

function inspectUntracked(root: string, rawPath: string): UntrackedEntry {
  const relativePath = normalizeGitPath(root, rawPath);
  const absolute = path.join(root, ...relativePath.split("/"));
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(absolute);
    return {
      path: relativePath,
      mode: "120000",
      size: Buffer.byteLength(target),
      sha256: createHash("sha256").update(target).digest("hex"),
    };
  }
  if (!stat.isFile()) {
    throw new HyWorkflowError("GIT_UNTRACKED_FILE_UNSAFE", `Untracked path is not a regular file or symlink: ${relativePath}`);
  }
  return {
    path: relativePath,
    mode: (stat.mode & 0o111) === 0 ? "100644" : "100755",
    size: stat.size,
    sha256: hashRegularFile(absolute, stat),
  };
}

function addFrame(hash: ReturnType<typeof createHash>, label: string, value: Buffer | string): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  hash.update(label);
  hash.update("\0");
  hash.update(String(bytes.length));
  hash.update("\0");
  hash.update(bytes);
  hash.update("\0");
}

function compareChanges(left: GitChange, right: GitChange): number {
  return left.paths.join("\0").localeCompare(right.paths.join("\0")) || left.status.localeCompare(right.status);
}

function snapshotOnce(root: string): GitSnapshot {
  const headResult = runGit(root, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  if (headResult.status !== 0) {
    throw new HyWorkflowError("GIT_HEAD_UNAVAILABLE", "The repository does not have a committed HEAD yet.");
  }
  const head = headResult.stdout.toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) {
    throw new HyWorkflowError("GIT_HEAD_INVALID", "Git returned an invalid HEAD object id.");
  }

  const commonDiffArgs = ["--binary", "--full-index", "--no-ext-diff", "--no-textconv"] as const;
  const finalDiff = runGit(root, ["diff", ...commonDiffArgs, "HEAD", "--"]).stdout;
  const stagedDiff = runGit(root, ["diff", ...commonDiffArgs, "--cached", "HEAD", "--"]).stdout;
  const unstagedDiff = runGit(root, ["diff", ...commonDiffArgs, "--"]).stdout;

  const statusArgs = ["--name-status", "-z", "--find-renames=50%", "--no-ext-diff", "--no-textconv"] as const;
  const changes = [
    ...parseNameStatus(runGit(root, ["diff", ...statusArgs, "HEAD", "--"]).stdout),
    ...parseNameStatus(runGit(root, ["diff", ...statusArgs, "--cached", "HEAD", "--"]).stdout),
    ...parseNameStatus(runGit(root, ["diff", ...statusArgs, "--"]).stdout),
  ].map(change => ({ ...change, paths: change.paths.map(item => normalizeGitPath(root, item)) }));

  const untrackedPaths = splitNull(runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout)
    .map(item => normalizeGitPath(root, item))
    .sort();
  const untracked = untrackedPaths.map(item => inspectUntracked(root, item));
  changes.push(...untracked.map(item => ({ status: "untracked" as const, paths: [item.path] })));

  const uniqueChanges = [...new Map(
    changes.map(change => [`${change.status}\0${change.paths.join("\0")}`, change]),
  ).values()].sort(compareChanges);
  const changedPaths = [...new Set(uniqueChanges.flatMap(change => change.paths))].sort();

  const hash = createHash("sha256");
  addFrame(hash, "head", head);
  addFrame(hash, "final-diff", finalDiff);
  addFrame(hash, "staged-diff", stagedDiff);
  addFrame(hash, "unstaged-diff", unstagedDiff);
  addFrame(hash, "untracked", stableJsonStringify(untracked));
  addFrame(hash, "changes", stableJsonStringify(uniqueChanges));
  return { root, head, diffHash: hash.digest("hex"), changes: uniqueChanges, changedPaths };
}

export function captureStableSnapshot(root: string): GitSnapshot {
  const first = snapshotOnce(root);
  const second = snapshotOnce(root);
  if (first.head !== second.head || first.diffHash !== second.diffHash
    || stableJsonStringify(first.changes) !== stableJsonStringify(second.changes)) {
    throw new HyWorkflowError("GIT_SNAPSHOT_UNSTABLE", "The Git worktree changed while inspect was taking its snapshot.");
  }
  return second;
}
