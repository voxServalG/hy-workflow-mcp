import * as path from "node:path";

export const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

export type DocsDirResolution =
  | { ok: true; docsDir: string; docsRoot: string }
  | { ok: false; error: string };

function slashPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function isDocumentPath(file: string): boolean {
  return DOC_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export function isInsidePath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function relativeInside(root: string, target: string): string | null {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return slashPath(relative);
}

export function resolveDocsDir(root: string, configuredDocsDir: string): DocsDirResolution {
  const raw = configuredDocsDir.trim();
  if (!raw) return { ok: false, error: "project.docsDir is empty." };
  if (raw !== configuredDocsDir) return { ok: false, error: `project.docsDir has surrounding whitespace: ${configuredDocsDir}` };
  if (path.isAbsolute(raw)) return { ok: false, error: `project.docsDir must be project-relative: ${configuredDocsDir}` };
  if (raw.split(/[\/]+/).includes("..")) return { ok: false, error: `project.docsDir must not contain parent segments: ${configuredDocsDir}` };

  const docsRoot = path.resolve(root, raw);
  if (!isInsidePath(root, docsRoot)) return { ok: false, error: `project.docsDir escapes the project root: ${configuredDocsDir}` };
  const relative = path.relative(root, docsRoot);
  const docsDir = relative ? slashPath(relative) : ".";
  return { ok: true, docsDir, docsRoot };
}

export function pathInsideDocs(root: string, docsDir: string, file: string): boolean {
  const resolved = path.resolve(root, file);
  const docs = resolveDocsDir(root, docsDir);
  if (!docs.ok) return false;
  return isInsidePath(docs.docsRoot, resolved);
}

export function relativeToDocs(docsRoot: string, target: string): string | null {
  return relativeInside(docsRoot, target);
}
