import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".hy",
  ".codex",
  ".opencode",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

export function slashPath(value) {
  return value.split(path.sep).join("/");
}

export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeRelative(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || path.isAbsolute(value)) {
    return null;
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return null;
  return slashPath(normalized === "" ? "." : normalized);
}

export function safeResolve(root, relative) {
  const normalized = normalizeRelative(relative);
  if (normalized === null) return { ok: false, error: `unsafe project-relative path: ${String(relative)}` };
  const projectRoot = path.resolve(root);
  const target = path.resolve(projectRoot, normalized);
  if (!isInside(projectRoot, target)) return { ok: false, error: `path escapes the project root: ${relative}` };

  try {
    const canonicalRoot = fs.realpathSync(projectRoot);
    let existing = target;
    while (!fs.existsSync(existing) && existing !== projectRoot) existing = path.dirname(existing);
    const canonicalExisting = fs.realpathSync(existing);
    if (!isInside(canonicalRoot, canonicalExisting)) {
      return { ok: false, error: `path resolves outside the project root: ${relative}` };
    }
  } catch (error) {
    return { ok: false, error: `path cannot be resolved safely: ${relative}: ${error?.message ?? String(error)}` };
  }
  return { ok: true, path: target, relative: normalized };
}

export function relativePath(root, target) {
  if (!isInside(path.resolve(root), path.resolve(target))) return null;
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative ? slashPath(relative) : ".";
}

export function readTextFile(root, relative) {
  const resolved = safeResolve(root, relative);
  if (!resolved.ok) return resolved;
  try {
    const stat = fs.lstatSync(resolved.path);
    if (stat.isSymbolicLink()) return { ok: false, error: `symbolic links are not scanned: ${relative}` };
    if (!stat.isFile()) return { ok: false, error: `expected a regular file: ${relative}` };
    return { ok: true, text: fs.readFileSync(resolved.path, "utf8"), path: resolved.path, relative: resolved.relative };
  } catch (error) {
    return { ok: false, error: `cannot read ${relative}: ${error?.message ?? String(error)}` };
  }
}

export function listFiles(root, roots, options = {}) {
  const extensions = new Set((options.extensions ?? []).map(ext => ext.toLowerCase()));
  const ignored = new Set([...DEFAULT_IGNORED_DIRECTORIES, ...(options.ignoreDirectories ?? [])]);
  const files = [];
  const issues = [];
  const seen = new Set();

  const walk = (absolute, configuredRoot) => {
    let entries;
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      issues.push({ path: configuredRoot, message: `cannot enumerate directory: ${error?.message ?? String(error)}` });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const full = path.join(absolute, entry.name);
      const relative = relativePath(root, full);
      if (relative === null) {
        issues.push({ path: configuredRoot, message: `encountered path outside project root: ${full}` });
        continue;
      }
      if (entry.isSymbolicLink()) {
        issues.push({ path: relative, message: "symbolic link skipped to preserve scan boundary" });
        continue;
      }
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name) && !entry.name.startsWith(".")) walk(full, configuredRoot);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions.size > 0 && !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      if (!seen.has(relative)) {
        seen.add(relative);
        files.push(relative);
      }
    }
  };

  for (const configuredRoot of [...new Set(roots)].sort((a, b) => a.localeCompare(b, "en"))) {
    const resolved = safeResolve(root, configuredRoot);
    if (!resolved.ok) {
      issues.push({ path: String(configuredRoot), message: resolved.error });
      continue;
    }
    try {
      const stat = fs.lstatSync(resolved.path);
      if (stat.isSymbolicLink()) {
        issues.push({ path: resolved.relative, message: "configured scan root must not be a symbolic link" });
      } else if (!stat.isDirectory()) {
        issues.push({ path: resolved.relative, message: "configured scan root is not a directory" });
      } else {
        walk(resolved.path, resolved.relative);
      }
    } catch (error) {
      issues.push({ path: resolved.relative, message: `configured scan root is unavailable: ${error?.message ?? String(error)}` });
    }
  }

  files.sort((a, b) => a.localeCompare(b, "en"));
  issues.sort((a, b) => a.path.localeCompare(b.path, "en") || a.message.localeCompare(b.message, "en"));
  return { files, issues };
}

export function countTextLines(text) {
  if (text.length === 0) return 0;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

export function countGenericEffectiveLines(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const effective = new Set();
  let blockComment = false;
  let quote = null;
  let escaped = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    let hasCode = false;
    for (let index = 0; index < line.length; index++) {
      const current = line[index];
      const next = line[index + 1];
      if (blockComment) {
        if (current === "*" && next === "/") {
          blockComment = false;
          index++;
        }
        continue;
      }
      if (quote) {
        hasCode = true;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === quote) quote = null;
        continue;
      }
      if (current === "/" && next === "*") {
        blockComment = true;
        index++;
        continue;
      }
      if (current === "/" && next === "/") break;
      if (current === "'" || current === '"' || current === "`") {
        quote = current;
        hasCode = true;
        continue;
      }
      if (!/\s/.test(current)) hasCode = true;
    }
    if (hasCode) effective.add(lineIndex + 1);
    if (quote !== "`") {
      quote = null;
      escaped = false;
    }
  }
  return effective.size;
}
