import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export const MANAGED_RULES_VERSION = "2026.07.16.1";

export const DOCUMENT_READ_BUDGET = Object.freeze({
  maxFiles: 12,
  maxChars: 48_000,
  maxFileChars: 12_000,
  estimatedMaxTokens: 12_000,
});

export const IGNORED_DOC_DIRECTORIES = new Set([
  ".git", ".github", ".hy", ".codex", ".opencode",
  "node_modules", "vendor", "dist", "build", "target", "coverage",
  "examples", "example", "fixtures", "fixture", "generated", "__generated__",
  ".venv", "venv", "__pycache__", ".tox", ".pytest_cache",
]);

export interface DocumentationIssue {
  code: "DOCS_EMPTY" | "DOCS_NO_FACTS" | "STALE_MANAGED_AGENTS";
  message: string;
  file?: string;
  recovery: string;
}

export interface DocumentPageFile {
  path: string;
  bytes: number;
  chars: number;
  sha256: string;
  content: string;
  truncated: boolean;
  omittedChars: number;
  score: number;
}

export interface DocumentPage {
  files: DocumentPageFile[];
  budget: {
    maxFiles: number;
    maxChars: number;
    maxFileChars: number;
    estimatedMaxTokens: number;
    selectedFiles: number;
    selectedChars: number;
    estimatedTokens: number;
    truncatedFiles: number;
  };
  pagination: {
    cursor: string;
    offset: number;
    hasMore: boolean;
    nextCursor: string | null;
    omittedFiles: number;
  };
}

function slash(value: string): string {
  return value.split(path.sep).join("/");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function shouldIgnoreDocumentPath(relativePath: string): boolean {
  const parts = slash(relativePath).split("/").filter(Boolean);
  return parts.some((part, index) => {
    if (IGNORED_DOC_DIRECTORIES.has(part.toLowerCase())) return true;
    return index < parts.length - 1 && part.startsWith(".");
  });
}

export function substantiveDocumentText(content: string): string {
  return content
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/^---\s*$[^]*?^---\s*$/m, " ")
    .replace(/```[^]*?```/g, " ")
    .replace(/:::\w*[^]*?:::/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSubstantiveDocument(content: string): boolean {
  const text = substantiveDocumentText(content);
  return text.length >= 12 && /[A-Za-z0-9\u4e00-\u9fff]{3}/.test(text);
}

export function staleManagedAgentsReasons(content: string): string[] {
  if (!content.includes("<!-- hy-workflow-rules -->")) return [];
  const managed = content.split("<!-- hy-workflow-rules -->", 2)[1]?.split("<!-- /hy-workflow-rules -->", 1)[0] ?? content;
  const reasons: string[] = [];
  const versionMatch = /<!--\s*hy-workflow-rules-version:\s*([^\s]+)\s*-->/.exec(managed);
  if (!versionMatch) reasons.push(`managed rules version marker is missing; expected ${MANAGED_RULES_VERSION}`);
  else if (versionMatch[1] !== MANAGED_RULES_VERSION) reasons.push(`managed rules version ${versionMatch[1]} is stale; expected ${MANAGED_RULES_VERSION}`);
  const obsolete: Array<[RegExp, string]> = [
    [/选择部署模式|choose deployment mode/i, "managed rules still require a deployment-mode choice"],
    [/共享模式（|本机模式（|shared mode \(|local mode \(/i, "managed rules still describe removed local/shared setup modes"],
    [/(?:^|\s)--local(?:\s|$)|(?:^|\s)--shared(?:\s|$)/im, "managed rules still advertise removed setup flags"],
    [/mode\s*[=:]\s*["']?(?:local|shared)/i, "managed rules still encode a legacy deployment mode"],
    [/hy_init[^\n。]*(?:创建|生成|writes?|creates?)[^\n。]*(?:\.hy\/|AGENTS\.md)/i, "managed rules say hy_init writes legacy project artifacts"],
  ];
  for (const [pattern, reason] of obsolete) if (pattern.test(managed)) reasons.push(reason);
  return reasons;
}

export function inspectDocumentation(
  root: string,
  files: string[],
  options: { includeAgents?: boolean } = {},
): { substantiveFiles: string[]; issues: DocumentationIssue[] } {
  const existing = files.filter(file => {
    try { return fs.statSync(path.join(root, file)).isFile(); }
    catch { return false; }
  });
  const substantiveFiles = existing.filter(file => {
    try { return isSubstantiveDocument(fs.readFileSync(path.join(root, file), "utf-8")); }
    catch { return false; }
  });
  const issues: DocumentationIssue[] = [];
  if (!existing.length) {
    issues.push({
      code: "DOCS_EMPTY",
      message: "The configured documentation system contains no readable document files.",
      recovery: "Add a README/index with project facts, or point project.docsDir at the maintained documentation system.",
    });
  } else if (!substantiveFiles.length) {
    issues.push({
      code: "DOCS_NO_FACTS",
      message: "The configured documentation system contains files but no substantive project facts.",
      recovery: "Document project constraints, terminology, workflow, and verification expectations before planning.",
    });
  }

  if (options.includeAgents !== false) {
    const agents = existing.find(file => slash(file).toLowerCase() === "agents.md");
    if (agents) {
      const reasons = staleManagedAgentsReasons(fs.readFileSync(path.join(root, agents), "utf-8"));
      if (reasons.length) {
        issues.push({
          code: "STALE_MANAGED_AGENTS",
          file: agents,
          message: `Managed AGENTS rules are stale: ${reasons.join("; ")}.`,
          recovery: "Run hy-workflow config --print-managed-rules, manually replace only the managed hy-workflow block, review that project diff, then rerun setup.",
        });
      }
    }
  }
  return { substantiveFiles, issues };
}

function taskTokens(task: string): Set<string> {
  return new Set(task.toLowerCase().split(/[^a-z0-9_\-\u4e00-\u9fff]+/).filter(token => token.length >= 2));
}

function rootEntryScore(file: string): number {
  const normalized = slash(file).toLowerCase();
  const basename = path.posix.basename(normalized);
  if (/^index\.(md|mdx|rst|txt)$/.test(basename)) return normalized.split("/").length <= 2 ? 120 : 80;
  if (/^readme\.(md|mdx|rst|txt)$/.test(basename)) return normalized.split("/").length <= 2 ? 110 : 70;
  if (normalized === "agents.md") return 105;
  return 0;
}

export function documentTaskScore(file: string, content: string, task: string, entryPoints: Set<string>): number {
  let score = rootEntryScore(file);
  if (entryPoints.has(file)) score += 100;
  const tokens = taskTokens(task);
  const haystack = `${file}\n${content.slice(0, 8_000)}`.toLowerCase();
  for (const token of tokens) if (haystack.includes(token)) score += 8;
  return score;
}

function parseCursor(cursor: string | undefined, digest: string): number {
  if (!cursor) return 0;
  const match = /^docs:([a-f0-9]{12}):(\d+)$/.exec(cursor);
  if (!match) throw new Error("Document cursor is malformed.");
  if (match[1] !== digest.slice(0, 12)) throw new Error("Document cursor is stale for the current DocsGraph.");
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Document cursor offset is invalid.");
  return offset;
}

function safeSlice(content: string, maxChars: number): { text: string; truncated: boolean; omittedChars: number } {
  if (content.length <= maxChars) return { text: content, truncated: false, omittedChars: 0 };
  if (maxChars < 160) return { text: content.slice(0, maxChars), truncated: true, omittedChars: content.length - maxChars };
  const provisional = content.length - maxChars;
  const marker = `\n\n[... ${provisional} characters omitted by document budget ...]\n\n`;
  const available = maxChars - marker.length;
  const headSize = Math.max(1, Math.floor(available * 0.72));
  const tailSize = Math.max(1, available - headSize);
  const omittedChars = content.length - headSize - tailSize;
  return { text: content.slice(0, headSize) + marker + content.slice(-tailSize), truncated: true, omittedChars };
}

export function selectDocumentPage(
  root: string,
  candidates: string[],
  task: string,
  entryPoints: string[],
  graphDigest: string,
  cursor?: string,
): DocumentPage {
  const entrySet = new Set(entryPoints);
  const ranked = [...new Set(candidates)].flatMap(file => {
    try {
      const content = fs.readFileSync(path.join(root, file), "utf-8");
      if (!isSubstantiveDocument(content)) return [];
      return [{ file, content, score: documentTaskScore(file, content, task, entrySet) }];
    } catch {
      return [];
    }
  }).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  const offset = parseCursor(cursor, graphDigest);
  const files: DocumentPageFile[] = [];
  let chars = 0;
  let index = offset;
  for (; index < ranked.length && files.length < DOCUMENT_READ_BUDGET.maxFiles; index++) {
    const item = ranked[index];
    const remaining = DOCUMENT_READ_BUDGET.maxChars - chars;
    if (remaining <= 0) break;
    const allowance = Math.min(DOCUMENT_READ_BUDGET.maxFileChars, remaining);
    const sliced = safeSlice(item.content, allowance);
    chars += sliced.text.length;
    files.push({
      path: item.file,
      bytes: Buffer.byteLength(item.content, "utf-8"),
      chars: item.content.length,
      sha256: sha256(item.content),
      content: sliced.text,
      truncated: sliced.truncated,
      omittedChars: sliced.omittedChars,
      score: item.score,
    });
  }
  const hasMore = index < ranked.length;
  const digestPrefix = graphDigest.slice(0, 12);
  return {
    files,
    budget: {
      ...DOCUMENT_READ_BUDGET,
      selectedFiles: files.length,
      selectedChars: chars,
      estimatedTokens: Math.ceil(chars / 4),
      truncatedFiles: files.filter(file => file.truncated).length,
    },
    pagination: {
      cursor: `docs:${digestPrefix}:${offset}`,
      offset,
      hasMore,
      nextCursor: hasMore ? `docs:${digestPrefix}:${index}` : null,
      omittedFiles: Math.max(0, ranked.length - index),
    },
  };
}
