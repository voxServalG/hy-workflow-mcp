import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertPhase,
  computePlanHash,
  projectRoot,
  readState,
  transition,
  writeState,
  type ImplementationManifest,
  type PlanDoc,
} from "../state.js";
import { buildImplementationManifest } from "../checks.js";
import { ensureGraph, incrementalUpdate, detectBrokenLinks } from "../docs_graph.js";
import { isDocumentPath, pathInsideDocs, resolveDocsDir } from "../docs_paths.js";
import { invalidWorkflowStateResult, toolResult, type ToolResult } from "./_base.js";
import { requireRuntimeConfig } from "../config.js";
import { shouldIgnoreDocumentPath } from "../policy/docs.js";
import { isRuntimeIgnoredArtifact } from "../policy/artifacts.js";

export function isSyncDocumentPath(file: string): boolean {
  if (shouldIgnoreDocumentPath(file)) return false;
  return file === "README.md"
    || file.startsWith("templates/")
    || file.startsWith("docs/")
    || isDocumentPath(file);
}

export function allowedSyncDocumentPaths(plan: PlanDoc): string[] {
  const declared = [...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete];
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
  return requireRuntimeConfig(root).project.docsDir as string;
}

export async function handleSyncDocs(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "edit", "verify");
  const currentStage = state.stage ?? (state.phase === "verify" ? "verify.run" : "edit.implementation");

  if (!state.plan) {
    return invalidWorkflowStateResult(
      state,
      "SYNC_DOCS_PLAN_MISSING",
      "Workflow state reached document synchronization without an active PlanDoc.",
      "Reset the impossible workflow state, then create and approve a new PlanDoc.",
    );
  }

  const planHash = computePlanHash(state.plan);
  const afterEdit = state.documentReads?.afterEdit;
  if (!planHash || afterEdit?.planHash !== planHash) {
    return toolResult("edit", {
      phase: state.phase,
      stage: currentStage,
      error: "after_edit document audit is required before hy_sync_docs.",
      allowedTools: ["hy_read_docs", "hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
    });
  }

  const root = projectRoot();
  let configuredDocsDir: string;
  try {
    configuredDocsDir = readDocsDir(root);
  } catch (error) {
    return toolResult("edit", {
      phase: state.phase,
      stage: currentStage,
      error,
      requires_user: true,
      userAction: { kind: "fix_configuration" },
      stop_here: true,
      allowedTools: ["hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
    });
  }

  const manifest = buildImplementationManifest(root);
  const currentImplementationDigest = implementationDigest(root, state.plan, manifest);
  if (afterEdit.implementationDigest !== currentImplementationDigest) {
    return toolResult("edit", {
      phase: state.phase,
      stage: currentStage,
      error: "Implementation diff changed after hy_read_docs(after_edit).",
      allowedTools: ["hy_read_docs", "hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
    });
  }

  if (isRuntimeIgnoredArtifact(root, configuredDocsDir)) {
    return toolResult("edit", {
      phase: state.phase,
      stage: currentStage,
      error: "Configured project.docsDir points to an ignored legacy or runtime path.",
      allowedTools: ["hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
    });
  }
  const resolvedDocsDir = resolveDocsDir(root, configuredDocsDir);
  if (!resolvedDocsDir.ok) {
    return toolResult("edit", {
      phase: state.phase,
      stage: currentStage,
      error: `Invalid project.docsDir: ${resolvedDocsDir.error}`,
      allowedTools: ["hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
    });
  }
  const { docsDir } = resolvedDocsDir;
  const allowedDocs = allowedSyncDocumentPaths(state.plan);

  // ── Incremental graph update ──────────────────────────────
  const graphChangedDocs = allowedDocs.filter(doc => pathInsideDocs(root, docsDir, doc));
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
  const next = state.phase === "edit" ? { ...state } : transition(state, "edit");
  next.stage = "edit.sync_docs";
  next.syncDocs = {
    time: new Date().toISOString(),
    planHash,
    afterEditDigest: afterEdit.digest,
    implementationDigest: currentImplementationDigest,
    allowedDocs,
  };
  writeState(next);

  return toolResult("verify", {
    phase: "edit",
    stage: "edit.sync_docs",
    status: graphInfo.brokenLinks > 0 ? "warning" : "passed",
    synced: true,
    allowedDocs,
    graphInfo,
    allowedTools: ["hy_verify", "hy_edit", "hy_status"],
    blockedTools: ["hy_commit", "hy_merge"],
    nextAction: { tool: "hy_verify", phase: "verify", stage: "verify.run", automatic: true },
    control: { automatic: true, stop: false, reason: "automatic" },
    userAction: null,
  });
}
