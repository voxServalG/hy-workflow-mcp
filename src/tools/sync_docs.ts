import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertPhase,
  computePlanHash,
  projectRoot,
  readState,
  writeState,
  type ImplementationManifest,
  type PlanDoc,
} from "../state.js";
import { buildImplementationManifest } from "../checks.js";
import { ensureGraph, incrementalUpdate, detectBrokenLinks } from "../docs_graph.js";
import { toolResult, type ToolResult } from "./_base.js";

const DOC_EXTENSIONS = [".md", ".mdx", ".txt", ".rst"];

export function isSyncDocumentPath(file: string): boolean {
  return file === "setup" || file === "README.md" || file === "AGENTS.md" || file.startsWith("docs/") || DOC_EXTENSIONS.some(ext => file.endsWith(ext));
}

export function allowedSyncDocumentPaths(plan: PlanDoc): string[] {
  const declared = [...plan.scope.changes, ...plan.scope.new_files];
  return declared.filter(isSyncDocumentPath).sort();
}

function shortHash(value: string): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex").slice(0, 12);
}

export function implementationFilesForDigest(plan: PlanDoc, manifest: ImplementationManifest): string[] {
  const allowedDocs = new Set(allowedSyncDocumentPaths(plan));
  return manifest.changed.filter(file => !allowedDocs.has(file)).sort();
}

export function implementationDigest(root: string, plan: PlanDoc, manifest: ImplementationManifest): string {
  const files = implementationFilesForDigest(plan, manifest).map(file => {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) return { file, sha256: "deleted" };
    const hash = createHash("sha256");
    hash.update(fs.readFileSync(fullPath));
    return { file, sha256: hash.digest("hex") };
  });
  return shortHash(JSON.stringify(files));
}

function readDocsDir(root: string): string {
  const configPath = path.join(root, "hy-workflow.json");
  if (!fs.existsSync(configPath)) return "docs";
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const docsDir = config?.project?.docsDir;
    return typeof docsDir === "string" && docsDir.trim() ? docsDir : "docs";
  } catch {
    return "docs";
  }
}

export async function handleSyncDocs(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "edit", "verify");

  if (!state.plan) return toolResult("edit", { phase: state.phase, error: "No plan", allowedTools: ["hy_status"] });

  const planHash = computePlanHash(state.plan);
  const afterEdit = state.documentReads?.afterEdit;
  if (!planHash || afterEdit?.planHash !== planHash) {
    return toolResult("edit", {
      phase: state.phase,
      error: "after_edit document audit is required before hy_sync_docs.",
      hint: "Call hy_read_docs with { stage: \"after_edit\" } after implementation edits, then call hy_sync_docs before hy_verify.",
      allowedTools: ["hy_read_docs", "hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_ci", "hy_merge", "hy_chain"],
    });
  }

  const manifest = buildImplementationManifest(projectRoot());
  const currentImplementationDigest = implementationDigest(projectRoot(), state.plan, manifest);
  if (afterEdit.implementationDigest !== currentImplementationDigest) {
    return toolResult("edit", {
      phase: state.phase,
      error: "Implementation diff changed after hy_read_docs(after_edit).",
      hint: "Rerun hy_read_docs with { stage: \"after_edit\" } so the document sync audit matches the current implementation diff.",
      allowedTools: ["hy_read_docs", "hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_ci", "hy_merge", "hy_chain"],
    });
  }

  const root = projectRoot();
  const docsDir = readDocsDir(root);
  const allowedDocs = allowedSyncDocumentPaths(state.plan);

  // ── Incremental graph update ──────────────────────────────
  const graphChangedDocs = allowedDocs.filter(
    doc => fs.existsSync(path.join(root, doc)) && doc.startsWith(docsDir)
  );
  let graphInfo = { updated: false, brokenLinks: 0, brokenLinkDetails: [] as string[] };

  if (graphChangedDocs.length > 0) {
    // Ensure graph is current before updating
    const graph = ensureGraph(root, docsDir);
    const updated = incrementalUpdate(root, graph, graphChangedDocs);
    graphInfo.updated = true;

    // Detect broken links across the graph
    const broken = detectBrokenLinks(updated.entries, root);
    graphInfo.brokenLinks = broken.length;
    if (broken.length > 0) {
      graphInfo.brokenLinkDetails = broken.map(
        b => `${b.source}:${b.line} → ${b.target} ("${b.anchor}")`
      );
    }
  }

  // ── Write syncDocs record ─────────────────────────────────
  const next = { ...state };
  next.syncDocs = {
    time: new Date().toISOString(),
    planHash,
    afterEditDigest: afterEdit.digest,
    implementationDigest: currentImplementationDigest,
    allowedDocs,
  };
  writeState(next);

  const displayBody: string[] = [
    "after_edit audit is current. Synchronize only the declared documentation or setup prompt files, then run hy_verify.",
    allowedDocs.length ? `Allowed sync files: ${allowedDocs.join(", ")}` : "No documentation sync files were declared in plan.scope.",
  ];
  if (graphInfo.updated) {
    displayBody.push(`DocsGraph incrementally updated for ${graphChangedDocs.length} changed file(s).`);
  }
  if (graphInfo.brokenLinks > 0) {
    displayBody.push(`⚠ ${graphInfo.brokenLinks} broken link(s) detected:`);
    displayBody.push(...graphInfo.brokenLinkDetails.map(d => `  - ${d}`));
  }

  return toolResult("verify", {
    phase: "edit",
    synced: true,
    allowedDocs,
    graphInfo,
    display: {
      title: "Document sync gate ready",
      body: displayBody.join("\n"),
      files: allowedDocs,
    },
    hint: "Use standard file editing tools only within plan.scope for documentation sync. When done, call hy_verify.",
    allowedTools: ["hy_verify", "hy_edit", "hy_status"],
    blockedTools: ["hy_commit", "hy_ci", "hy_merge", "hy_chain"],
  });
}
