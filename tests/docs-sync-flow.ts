import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { handleReadDocs } from "../src/tools/read_docs.js";
import { handleSyncDocs } from "../src/tools/sync_docs.js";
import { handleVerify } from "../src/tools/verify.js";
import { readState, writeState, type PlanDoc, type WorkflowState } from "../src/state.js";

function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

function basePlan(): PlanDoc {
  return {
    task: "sync documentation after implementation edits",
    scope: { changes: ["src/app.ts", "README.md"], new_files: [], delete: [] },
    boundary: {
      dependency_dag: "src/app.ts is the implementation entry; README.md documents the visible behavior.",
      entry_points: ["node --version"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "N/A", setup: ["node --version"] },
      smoke: [{ command: "node --version", expected_exit: 0, description: "node exists" }],
      tests: [{ command: "node --version", expected_exit: 0, description: "node exists" }],
    },
    risks: ["Scenario: docs sync is skipped; impact: stale README ships with code; mitigation: hy_verify requires after_edit and hy_sync_docs."],
    discussion: "Use an after_edit document audit plus hy_sync_docs before verify. A verify-after-docs approach was rejected because documentation changes need lint coverage.",
    branch: "feat/docs-sync-flow",
    verify_hash: null,
    pr_number: null,
  };
}

function editState(plan: PlanDoc): WorkflowState {
  return {
    version: "1",
    phase: "edit",
    branch: "feat/docs-sync-flow",
    prNumber: null,
    plan,
    approval: { time: new Date().toISOString(), note: "test" },
    verifyHash: null,
  };
}

const originalCwd = cwd();
const root = mkdtempSync(join(tmpdir(), "hy-docs-sync-"));

try {
  run("git init -b main", root);
  run("git config user.email test@example.com", root);
  run("git config user.name Test", root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "README.md"), "# App\n\nValue is 1.\n");
  writeFileSync(join(root, "docs", "workflow.md"), "# Workflow\n\nDocs sync happens before verify.\n");
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({ project: { docsDir: "docs" } }, null, 2) + "\n");
  writeFileSync(join(root, "codelint.json"), JSON.stringify({ baseBranch: "main" }, null, 2) + "\n");
  run("git add .", root);
  run("git commit -m init", root);
  run("git update-ref refs/remotes/origin/main HEAD", root);

  chdir(root);
  writeFileSync(join(root, "src", "app.ts"), "export const value = 2;\n");

  const plan = basePlan();
  writeState(editState(plan));

  const missingAfterEdit = await handleVerify();
  if (!String(missingAfterEdit.error).includes("after_edit")) {
    throw new Error(`hy_verify should require after_edit first, got ${JSON.stringify(missingAfterEdit)}`);
  }

  const afterEdit = await handleReadDocs({ stage: "after_edit" });
  if (afterEdit.phase !== "edit" || afterEdit.stage !== "after_edit") {
    throw new Error(`after_edit should stay in edit, got ${JSON.stringify(afterEdit)}`);
  }
  // Check graph-driven fields in after_edit
  if (!afterEdit.snapshot?.docsGraphDigest) {
    throw new Error(`after_edit snapshot missing docsGraphDigest, got ${JSON.stringify(afterEdit.snapshot)}`);
  }
  const stateAfterRead = readState();
  if (!stateAfterRead.documentReads?.afterEdit?.implementationDigest) {
    throw new Error("after_edit should store implementation digest");
  }

  const missingSync = await handleVerify();
  if (!String(missingSync.error).includes("hy_sync_docs")) {
    throw new Error(`hy_verify should require hy_sync_docs, got ${JSON.stringify(missingSync)}`);
  }

  const synced = await handleSyncDocs();
  if (synced.phase !== "edit" || !synced.synced) {
    throw new Error(`hy_sync_docs should keep edit phase and mark synced, got ${JSON.stringify(synced)}`);
  }
  if (!readState().syncDocs?.allowedDocs.includes("README.md")) {
    throw new Error("hy_sync_docs should record README.md as an allowed sync file");
  }
  // Check graph update info exists (graph only updates for docsDir files, not README.md)
  if (!synced.graphInfo || typeof synced.graphInfo.updated !== "boolean") {
    throw new Error(`hy_sync_docs should report graphInfo with updated status, got ${JSON.stringify(synced.graphInfo)}`);
  }

  const syncedState = readState();
  const changedPlan = { ...plan, discussion: `${plan.discussion} Changed after after_edit.` };
  writeState({ ...syncedState, phase: "edit", plan: changedPlan });
  const staleAfterEdit = await handleVerify();
  if (!String(staleAfterEdit.error).includes("after_edit plan hash does not match")) {
    throw new Error(`hy_verify should reject stale after_edit audit, got ${JSON.stringify(staleAfterEdit)}`);
  }

  writeState(syncedState);
  writeFileSync(join(root, "README.md"), "# App\n\nValue is 2.\n");
  const verified = await handleVerify();
  if (String(verified.error).includes("after_edit") || String(verified.error).includes("hy_sync_docs") || String(verified.error).includes("Implementation diff changed")) {
    throw new Error(`hy_verify should pass the document sync preflight after docs-only edits, got ${JSON.stringify(verified)}`);
  }

  writeState({ ...readState(), phase: "edit" });
  writeFileSync(join(root, "src", "app.ts"), "export const value = 3;\n");
  const stale = await handleVerify();
  if (!String(stale.error).includes("after_edit implementation digest does not match")) {
    throw new Error(`hy_verify should detect implementation drift after sync docs, got ${JSON.stringify(stale)}`);
  }
} finally {
  chdir(originalCwd);
}
