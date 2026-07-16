import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { MANAGED_RULES_VERSION } from "../policy/docs.js";

export const AGENTS_OPEN = "<!-- hy-workflow-rules -->";
export const AGENTS_CLOSE = "<!-- /hy-workflow-rules -->";
export const AGENTS_FILE = "AGENTS.md";

const CANONICAL_SOURCE = new URL("../../AGENTS.md", import.meta.url);

export interface ManagedBlockExtraction {
  found: boolean;
  wellFormed: boolean;
  openIndex: number;
  closeIndex: number;
  preOutside: string;
  managed: string;
  postOutside: string;
  outsideSha256: string | null;
  version: string | null;
  current: boolean;
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");
}

export function extractManagedBlock(content: string): ManagedBlockExtraction {
  const open = content.indexOf(AGENTS_OPEN);
  const close = content.lastIndexOf(AGENTS_CLOSE);
  const wellFormed = open >= 0 && close >= 0 && close > open;
  if (!wellFormed) {
    const outside = content;
    return {
      found: open >= 0 && close >= 0,
      wellFormed: false,
      openIndex: open,
      closeIndex: close,
      preOutside: outside,
      managed: "",
      postOutside: "",
      outsideSha256: outside.length ? sha256(outside) : null,
      version: null,
      current: false,
    };
  }
  const managedStart = open + AGENTS_OPEN.length;
  const managedEnd = close;
  const preOutside = content.slice(0, open);
  const managed = content.slice(managedStart, managedEnd);
  const postOutside = content.slice(close + AGENTS_CLOSE.length);
  const outside = preOutside + postOutside;
  const versionMatch = /<!--\s*hy-workflow-rules-version:\s*([^\s]+)\s*-->/.exec(managed);
  return {
    found: true,
    wellFormed: true,
    openIndex: open,
    closeIndex: close,
    preOutside,
    managed,
    postOutside,
    outsideSha256: outside.length ? sha256(outside) : null,
    version: versionMatch ? versionMatch[1] : null,
    current: versionMatch ? versionMatch[1] === MANAGED_RULES_VERSION : false,
  };
}

export function canonicalManagedBlock(): string {
  const content = fs.readFileSync(CANONICAL_SOURCE, "utf-8");
  const extraction = extractManagedBlock(content);
  if (!extraction.wellFormed || !extraction.current) {
    throw new Error(`Packaged AGENTS.md managed block is missing or does not match version ${MANAGED_RULES_VERSION}`);
  }
  return `${AGENTS_OPEN}${extraction.managed}${AGENTS_CLOSE}`;
}

export interface AgentsMigrationResult {
  file: string;
  existed: boolean;
  previousContent: string | null;
  nextContent: string;
  changed: boolean;
  changeKind: "create" | "managed_update" | "managed_insert" | "none";
  preOutsideSha256: string | null;
  postOutsideSha256: string | null;
  outsidePreserved: boolean;
}

function outsideOf(content: string): string {
  const extraction = extractManagedBlock(content);
  if (!extraction.wellFormed) return content;
  return extraction.preOutside + extraction.postOutside.replace(/^\n+/, "");
}

export function planAgentsFile(root: string): AgentsMigrationResult {
  const target = path.join(root, "AGENTS.md");
  const canonical = canonicalManagedBlock();
  const existed = fs.existsSync(target);
  const previousContent = existed ? fs.readFileSync(target, "utf-8") : null;
  if (!existed) {
    return {
      file: "AGENTS.md",
      existed: false,
      previousContent: null,
      nextContent: canonical + "\n",
      changed: true,
      changeKind: "create",
      preOutsideSha256: null,
      postOutsideSha256: null,
      outsidePreserved: true,
    };
  }
  const previous = previousContent!;
  const extraction = extractManagedBlock(previous);
  let nextContent: string;
  let changeKind: AgentsMigrationResult["changeKind"];
  let preHash: string | null;
  if (!extraction.wellFormed) {
    nextContent = canonical + "\n" + previous;
    changeKind = "managed_insert";
    preHash = sha256(previous);
  } else {
    nextContent = extraction.preOutside + canonical + extraction.postOutside;
    changeKind = "managed_update";
    preHash = sha256(outsideOf(previous));
  }
  if (!nextContent.endsWith("\n")) nextContent += "\n";
  const postHash = sha256(outsideOf(nextContent));
  const changed = nextContent !== previous;
  return {
    file: "AGENTS.md",
    existed,
    previousContent: previous,
    nextContent,
    changed,
    changeKind: changed ? changeKind : "none",
    preOutsideSha256: preHash,
    postOutsideSha256: postHash,
    outsidePreserved: !existed || !changed || preHash === null || preHash === postHash,
  };
}

export function outsidePreserved(root: string, expectedSha256: string | null): boolean {
  const target = path.join(root, "AGENTS.md");
  if (!fs.existsSync(target)) return expectedSha256 === null;
  const extraction = extractManagedBlock(fs.readFileSync(target, "utf-8"));
  return extraction.outsideSha256 === expectedSha256;
}
