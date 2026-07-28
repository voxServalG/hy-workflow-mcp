import * as fs from "node:fs";
import * as path from "node:path";
import { listFiles, readTextFile, relativePath, safeResolve, slashPath } from "./fs.mjs";
import { githubSlug, parseMarkdown } from "./markdown.mjs";

const DOC_EXTENSIONS = [".md", ".mdx"];

function finding(rule, severity, filePath, message, line) {
  return {
    rule,
    severity,
    path: filePath,
    ...(Number.isInteger(line) && line > 0 ? { line } : {}),
    message,
  };
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function thresholds(config) {
  const lint = config?.doclint ?? {};
  const issues = [];
  for (const field of ["maxLines", "maxLinesWarning", "maxLinesError"]) {
    if (lint[field] !== undefined && positiveInteger(lint[field]) === null) issues.push(`doclint.${field} must be a positive integer`);
  }
  const legacyError = positiveInteger(lint.maxLines);
  const error = positiveInteger(lint.maxLinesError) ?? legacyError ?? 500;
  const warning = positiveInteger(lint.maxLinesWarning) ?? 200;
  if (legacyError !== null && positiveInteger(lint.maxLinesError) !== null && legacyError !== lint.maxLinesError) {
    issues.push("doclint.maxLinesError must equal legacy doclint.maxLines when both are configured");
  }
  if (warning > error) issues.push("doclint.maxLinesWarning must not exceed doclint.maxLinesError");
  return { warning, error, issues };
}

function entryFiles(files, docsDir) {
  const root = docsDir === "." ? "" : `${docsDir.replace(/\/+$/, "")}/`;
  const expected = new Set([
    `${root}index.md`.toLowerCase(),
    `${root}index.mdx`.toLowerCase(),
    `${root}readme.md`.toLowerCase(),
    `${root}readme.mdx`.toLowerCase(),
  ]);
  return files.filter(file => expected.has(file.toLowerCase()));
}

function decodeTarget(target) {
  try {
    return decodeURI(target);
  } catch {
    return null;
  }
}

function splitTarget(target) {
  const hashIndex = target.indexOf("#");
  const beforeHash = hashIndex < 0 ? target : target.slice(0, hashIndex);
  const fragment = hashIndex < 0 ? "" : target.slice(hashIndex + 1);
  const queryIndex = beforeHash.indexOf("?");
  return {
    targetPath: queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex),
    fragment,
  };
}

function externalTarget(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("/");
}

function resolveLinkTarget(root, sourceFile, rawTarget) {
  if (externalTarget(rawTarget)) return { external: true };
  const decoded = decodeTarget(rawTarget);
  if (decoded === null) return { ok: false, error: "link target contains invalid URL encoding" };
  const { targetPath, fragment } = splitTarget(decoded);
  const relative = targetPath
    ? slashPath(path.relative(root, path.resolve(root, path.dirname(sourceFile), targetPath)))
    : sourceFile;
  const resolved = safeResolve(root, relative);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  let target = resolved.path;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return { ok: false, error: "link target is a symbolic link" };
    if (stat.isDirectory()) {
      const candidates = ["README.md", "index.md", "README.mdx", "index.mdx"]
        .map(name => path.join(target, name))
        .filter(candidate => fs.existsSync(candidate));
      if (candidates.length === 0) return { ok: false, error: "link points to a directory without README.md or index.md" };
      target = candidates[0];
    } else if (!stat.isFile()) {
      return { ok: false, error: "link target is not a regular file" };
    }
  } catch (error) {
    return { ok: false, error: `link target does not exist: ${error?.code === "ENOENT" ? relative : error?.message ?? String(error)}` };
  }
  const projectRelative = relativePath(root, target);
  if (projectRelative === null) return { ok: false, error: "link target escapes the project root" };
  return { ok: true, target: projectRelative, fragment };
}

function fragmentExists(fragment, parsed) {
  if (!fragment) return true;
  let decoded;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    return false;
  }
  return parsed.anchors.has(decoded)
    || parsed.anchors.has(decoded.toLowerCase())
    || parsed.anchors.has(githubSlug(decoded));
}

export function lintDocs({ root, config }) {
  const findings = [];
  const docsDir = config?.project?.docsDir;
  if (typeof docsDir !== "string" || !docsDir) {
    findings.push(finding("D001", "error", "hy-workflow.json", "project.docsDir must be configured"));
    return { files: [], findings, parsed: new Map(), entries: [] };
  }

  const listed = listFiles(root, [docsDir], { extensions: DOC_EXTENSIONS });
  listed.files = listed.files.filter(file => !["agents.md", "claude.md"].includes(path.basename(file).toLowerCase()));
  for (const issue of listed.issues) findings.push(finding("D001", "error", issue.path, issue.message));
  if (listed.files.length === 0) {
    findings.push(finding("D001", "error", docsDir, "documentation directory must contain at least one Markdown file"));
    return { files: [], findings, parsed: new Map(), entries: [] };
  }

  const parsed = new Map();
  for (const file of listed.files) {
    const read = readTextFile(root, file);
    if (!read.ok) {
      findings.push(finding("D001", "error", file, read.error));
      continue;
    }
    const document = parseMarkdown(read.text);
    parsed.set(file, document);
    if (document.unterminatedFence) findings.push(finding("D004", "error", file, "unterminated fenced code block"));
    for (const issue of document.structure) findings.push(finding("D004", "error", file, issue.message, issue.line));
  }

  const entries = entryFiles(listed.files, docsDir);
  if (entries.length === 0) {
    findings.push(finding("D002", "error", docsDir, "documentation system requires index.md or README.md as an entry point"));
  } else {
    const reachable = new Set(entries);
    const queue = [...entries];
    while (queue.length > 0) {
      const current = queue.shift();
      const document = parsed.get(current);
      if (!document) continue;
      for (const link of document.links) {
        const target = resolveLinkTarget(root, current, link.target);
        if (!target.ok || target.external || !parsed.has(target.target) || reachable.has(target.target)) continue;
        reachable.add(target.target);
        queue.push(target.target);
      }
    }
    for (const file of listed.files) {
      if (!reachable.has(file)) findings.push(finding("D002", "error", file, "document is not reachable from a documentation entry point"));
    }
  }

  const targetCache = new Map(parsed);
  for (const [file, document] of parsed) {
    for (const link of document.links) {
      const target = resolveLinkTarget(root, file, link.target);
      if (target.external) continue;
      if (!target.ok) {
        findings.push(finding("D003", "error", file, `${target.error}: ${link.target}`, link.line));
        continue;
      }
      if (!target.fragment) continue;
      const extension = path.extname(target.target).toLowerCase();
      if (!DOC_EXTENSIONS.includes(extension)) {
        findings.push(finding("D003", "error", file, `anchor target is not Markdown: ${link.target}`, link.line));
        continue;
      }
      let targetDocument = targetCache.get(target.target);
      if (!targetDocument) {
        const read = readTextFile(root, target.target);
        if (!read.ok) {
          findings.push(finding("D003", "error", file, `${read.error}: ${link.target}`, link.line));
          continue;
        }
        targetDocument = parseMarkdown(read.text);
        targetCache.set(target.target, targetDocument);
      }
      if (!fragmentExists(target.fragment, targetDocument)) {
        findings.push(finding("D003", "error", file, `anchor does not exist: ${link.target}`, link.line));
      }
    }
  }

  const limits = thresholds(config);
  for (const issue of limits.issues) findings.push(finding("D005", "error", "hy-workflow.json", issue));
  for (const [file, document] of parsed) {
    if (document.effectiveLines > limits.error) {
      findings.push(finding("D005", "error", file, `document has ${document.effectiveLines} effective lines; error threshold is ${limits.error}`));
    } else if (document.effectiveLines > limits.warning) {
      findings.push(finding("D005", "warning", file, `document has ${document.effectiveLines} effective lines; warning threshold is ${limits.warning}`));
    }
  }
  return { files: listed.files, findings, parsed, entries };
}
