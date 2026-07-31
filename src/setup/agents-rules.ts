import { createHash } from "node:crypto";

export const AGENTS_OPEN = "<!-- hy-workflow-rules -->";
export const AGENTS_CLOSE = "<!-- /hy-workflow-rules -->";
export const AGENTS_FILE = "AGENTS.md";
export const ASYNC_VERIFY_GUIDANCE = "Use hy_verify for checks expected under 60 seconds; use hy_exam_plan and hy_exam_submit for long-running acceptance or verification suites. Both paths produce the same verifyHash gate.";

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
    current: false,
  };
}

export function canonicalManagedBlock(): string {
  // Compatibility export only. There is no packaged policy block and setup
  // must never source a new project injection from this module.
  return "";
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

export function planAgentsFile(_root: string): AgentsMigrationResult {
  return {
    file: "AGENTS.md",
    existed: false,
    previousContent: null,
    nextContent: "",
    changed: false,
    changeKind: "none",
    preOutsideSha256: null,
    postOutsideSha256: null,
    outsidePreserved: true,
  };
}

export function outsidePreserved(_root: string, _expectedSha256: string | null): boolean {
  return true;
}
