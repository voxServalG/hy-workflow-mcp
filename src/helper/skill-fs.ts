import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  HELPER_SKILL_AGENTS,
  fail,
  type HelperSkillAgent,
  type HelperSkillProjectionPreference,
  type HelperSkillTarget,
  type HelperSkillTargetRecord,
} from "./skill-types.js";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function lstat(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function removeResource(file: string): void {
  const stat = lstat(file);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fs.rmSync(file, { force: true });
  else fs.rmSync(file, { recursive: true, force: true });
}

function assertAbsoluteSafeDirectory(directory: string, label: string): string {
  if (!path.isAbsolute(directory)) {
    fail("HELPER_SKILL_PATH_UNSAFE", `${label} must be absolute: ${directory}`);
  }
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  if (resolved === root || path.basename(resolved) !== "skills") {
    fail("HELPER_SKILL_PATH_UNSAFE", `${label} must identify an exact global skills directory: ${directory}`);
  }
  return resolved;
}

export function assertNoOverlap(left: string, right: string, label: string): void {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  if (relativeLeft === "" || (!relativeLeft.startsWith("..") && !path.isAbsolute(relativeLeft))
    || (!relativeRight.startsWith("..") && !path.isAbsolute(relativeRight))) {
    fail("HELPER_SKILL_PATH_UNSAFE", `${label} paths overlap: ${left} and ${right}`);
  }
}

function collectFiles(root: string): Array<{ path: string; relative: string }> {
  const files: Array<{ path: string; relative: string }> = [];
  const walk = (directory: string): void => {
    const directoryStat = lstat(directory);
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
      fail("HELPER_SKILL_BUNDLE_INVALID", `Skill bundle directory is unsafe: ${directory}`);
    }
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        fail("HELPER_SKILL_BUNDLE_INVALID", `Skill bundle must not contain symlinks: ${file}`);
      }
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) files.push({ path: file, relative: path.relative(root, file).replaceAll(path.sep, "/") });
      else fail("HELPER_SKILL_BUNDLE_INVALID", `Skill bundle contains a special file: ${file}`);
    }
  };
  walk(root);
  return files;
}

export function hashDirectory(directory: string): string {
  const stat = lstat(directory);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Expected a real managed directory: ${directory}`);
  }
  const hash = createHash("sha256");
  for (const file of collectFiles(directory)) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(fs.readFileSync(file.path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function copyDirectory(source: string, destination: string): void {
  const sourceStat = lstat(source);
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    fail("HELPER_SKILL_BUNDLE_INVALID", `Copy source is not a safe directory: ${source}`);
  }
  fs.mkdirSync(destination, { recursive: false, mode: sourceStat.mode & 0o777 });
  for (const name of fs.readdirSync(source).sort()) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) fail("HELPER_SKILL_BUNDLE_INVALID", `Refusing to copy symlink: ${from}`);
    if (stat.isDirectory()) copyDirectory(from, to);
    else if (stat.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(to, stat.mode & 0o777); } catch {}
    } else fail("HELPER_SKILL_BUNDLE_INVALID", `Refusing to copy special file: ${from}`);
  }
}
export function publishPreparedNoReplace(prepared: string, destination: string): void {
  const stat = lstat(prepared);
  if (!stat) fail("HELPER_SKILL_JOURNAL_INVALID", `Prepared Skill resource disappeared: ${prepared}`);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(prepared), destination, process.platform === "win32" ? "junction" : "dir");
    fs.rmSync(prepared, { force: true });
    return;
  }
  if (stat.isFile()) {
    fs.copyFileSync(prepared, destination, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(destination, stat.mode & 0o777); } catch {}
    fs.rmSync(prepared, { force: true });
    return;
  }
  if (!stat.isDirectory()) {
    fail("HELPER_SKILL_BUNDLE_INVALID", `Prepared Skill resource has an unsupported type: ${prepared}`);
  }
  fs.mkdirSync(destination, { recursive: false, mode: stat.mode & 0o777 });
  try {
    for (const name of fs.readdirSync(prepared).sort()) {
      const source = path.join(prepared, name);
      const target = path.join(destination, name);
      const child = fs.lstatSync(source);
      if (child.isSymbolicLink()) fail("HELPER_SKILL_BUNDLE_INVALID", `Refusing to publish nested symlink: ${source}`);
      if (child.isDirectory()) copyDirectory(source, target);
      else if (child.isFile()) {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        try { fs.chmodSync(target, child.mode & 0o777); } catch {}
      } else fail("HELPER_SKILL_BUNDLE_INVALID", `Refusing to publish special file: ${source}`);
    }
  } catch (error) {
    removeResource(destination);
    throw error;
  }
  removeResource(prepared);
}


export function resourceFingerprint(file: string): string | null {
  const stat = lstat(file);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(file)}`;
  if (stat.isDirectory()) return `directory:${hashDirectory(file)}`;
  if (stat.isFile()) return `file:${sha256(fs.readFileSync(file))}`;
  return `special:${stat.mode}`;
}

export function ensureDirectory(directory: string, created: string[]): void {
  const missing: string[] = [];
  let current = path.resolve(directory);
  while (!lstat(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const currentStat = lstat(current);
  if (currentStat && (!currentStat.isDirectory() || currentStat.isSymbolicLink())) {
    fail("HELPER_SKILL_PATH_UNSAFE", `Directory parent is not a real directory: ${current}`);
  }
  for (const item of missing.reverse()) {
    fs.mkdirSync(item);
    created.push(item);
  }
}

export function pruneCreatedDirectories(created: string[]): void {
  for (const directory of [...created].sort((left, right) => right.length - left.length)) {
    try { fs.rmdirSync(directory); } catch {}
  }
}

export function stagePath(destination: string): string {
  return path.join(path.dirname(destination), `.${path.basename(destination)}.hy-stage-${randomUUID()}`);
}

export function resolvedDirectory(directory: string): string {
  try { return fs.realpathSync.native(directory); } catch { return path.resolve(directory); }
}

export function normalizeTargets(
  targets: HelperSkillTarget[],
  preference: HelperSkillProjectionPreference,
  ssotRoot: string,
): HelperSkillTargetRecord[] {
  if (!targets.length) fail("HELPER_SKILL_NO_TARGETS", "No installed Agent global Skill directory was detected.");
  const seenAgents = new Set<HelperSkillAgent>();
  const seenResolved = new Set<string>();
  const normalized = targets.map(target => {
    if (!HELPER_SKILL_AGENTS.includes(target.agent)) fail("HELPER_SKILL_PATH_UNSAFE", `Unsupported Skill Agent: ${target.agent}`);
    if (seenAgents.has(target.agent)) fail("HELPER_SKILL_PATH_UNSAFE", `Duplicate Skill Agent target: ${target.agent}`);
    seenAgents.add(target.agent);
    const skillsDir = assertAbsoluteSafeDirectory(path.resolve(target.skillsDir), `${target.agent} skillsDir`);
    assertNoOverlap(path.resolve(ssotRoot), skillsDir, `${target.agent} target and canonical root`);
    const resolvedSkillsDir = resolvedDirectory(skillsDir);
    assertNoOverlap(path.resolve(ssotRoot), resolvedSkillsDir, `${target.agent} resolved target and canonical root`);
    if (seenResolved.has(resolvedSkillsDir)) {
      fail("HELPER_SKILL_PATH_UNSAFE", `Two Agent targets resolve to the same directory: ${resolvedSkillsDir}`);
    }
    seenResolved.add(resolvedSkillsDir);
    return { agent: target.agent, skillsDir, resolvedSkillsDir, preference };
  });
  return normalized.sort((left, right) => left.agent.localeCompare(right.agent));
}
