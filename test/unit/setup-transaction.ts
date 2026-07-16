import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { projectPaths, userRoots } from "../../src/runtime/user-paths.js";
import { recoverSetupJournal, withSetupTransaction } from "../../src/setup/transaction.js";
import { makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";
import { setSetupTestHooks } from "../helpers/setup-hooks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

useRuntimeHome("hy-transaction-runtime-");
const root = makeGitProject("hy-transaction-");
const file = path.join(root, "transaction-target.txt");
fs.writeFileSync(file, "before\n");
if (process.platform !== "win32") fs.chmodSync(file, 0o740);
let failed = false;
try {
  await withSetupTransaction(root, "setup", transaction => {
    transaction.capture([file]);
    fs.writeFileSync(file, "applied\n");
    transaction.markApplied([file]);
    throw new Error("simulated failure");
  });
} catch (error: any) { failed = error?.message === "simulated failure"; }
assert(failed && fs.readFileSync(file, "utf-8") === "before\n", "transaction must restore a captured file after failure");
if (process.platform !== "win32") assert((fs.statSync(file).mode & 0o777) === 0o740, "transaction rollback must preserve the original file mode");
assert(!fs.existsSync(projectPaths(root).setupJournal), "complete rollback must clear the journal");
assert(Object.values(userRoots()).every(directory => !fs.existsSync(directory)), "failed first transaction must remove newly created empty runtime roots");

let active = 0;
let maxActive = 0;
const restoreLockHooks = setSetupTestHooks({ ownerDelayMs: 150 });
await Promise.all([1, 2].map(() => withSetupTransaction(root, "setup", async () => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  await new Promise(resolve => setTimeout(resolve, 30));
  active -= 1;
})));
restoreLockHooks();
assert(maxActive === 1, "a fresh lock directory without owner.json must remain live during the owner-write window");
assert(!fs.existsSync(projectPaths(root).setupLock), "serialized transactions must release the setup lock");

try {
  await withSetupTransaction(root, "setup", transaction => {
    transaction.markClient("client:codex:hy-workflow", {
      action: "install",
      previous: { definition: null, state: "absent" },
      desired: { definition: { command: "hy-workflow", args: [] }, state: "active" },
    });
    transaction.markClient("client:codex:docs-gardener", {
      action: "install",
      previous: { definition: null, state: "absent" },
      desired: { definition: { command: "docs-gardener", args: ["mcp"] }, state: "active" },
    });
    throw new Error("simulated client crash residue");
  });
} catch {}
assert(fs.existsSync(projectPaths(root).setupJournal), "an unresolved client mutation must preserve its evidence journal");
const reconciledResources: string[] = [];
await withSetupTransaction(root, "setup", () => undefined, {
  reconcileClient: evidence => {
    reconciledResources.push(evidence.resource);
    return evidence.action === "install" && Boolean(evidence.previous) && Boolean(evidence.desired);
  },
});
assert(
  reconciledResources.join(",") === "client:codex:docs-gardener,client:codex:hy-workflow"
    && !fs.existsSync(projectPaths(root).setupJournal),
  "safe client evidence reconciliation must unwind shared client resources in LIFO order and break the retry dead loop",
);

const expectedContent = "expected-but-not-marked\n";
let crashGapFailed = false;
try {
  await withSetupTransaction(root, "setup", transaction => {
    transaction.capture([file]);
    transaction.prepareExpected(file, createHash("sha256").update(expectedContent).digest("hex"));
    fs.writeFileSync(file, expectedContent);
    throw new Error("simulated crash before markApplied");
  });
} catch (error: any) { crashGapFailed = error?.message === "simulated crash before markApplied"; }
assert(crashGapFailed && fs.readFileSync(file, "utf-8") === "before\n", "persisted expected hash must close the write-to-markApplied crash gap");
assert(!fs.existsSync(projectPaths(root).setupJournal), "expected-hash rollback must clear the journal");

const partialA = path.join(root, "partial-a.txt");
const partialB = path.join(root, "partial-b.txt");
fs.writeFileSync(partialA, "a-before\n");
fs.writeFileSync(partialB, "b-before\n");
try {
  await withSetupTransaction(root, "setup", transaction => {
    transaction.capture([partialA, partialB]);
    transaction.prepareExpected(partialA, createHash("sha256").update("a-applied\n").digest("hex"));
    transaction.prepareExpected(partialB, createHash("sha256").update("b-applied\n").digest("hex"));
    fs.writeFileSync(partialA, "a-applied\n");
    fs.writeFileSync(partialB, "b-applied\n");
    transaction.markApplied([partialA, partialB]);
    fs.writeFileSync(partialB, "b-external\n");
    throw new Error("partial recovery conflict");
  });
} catch {}
assert(fs.readFileSync(partialA, "utf-8") === "a-before\n" && fs.readFileSync(partialB, "utf-8") === "b-external\n", "first recovery pass must restore safe files and preserve conflicts");
assert(fs.existsSync(projectPaths(root).setupJournal), "partial recovery must retain its journal");
fs.writeFileSync(partialB, "b-applied\n");
const secondRecovery = recoverSetupJournal(root);
assert(secondRecovery.recovered && fs.readFileSync(partialA, "utf-8") === "a-before\n" && fs.readFileSync(partialB, "utf-8") === "b-before\n", "second recovery must treat already-restored resources as idempotently unchanged");
assert(!fs.existsSync(projectPaths(root).setupJournal), "idempotent second recovery must clear the journal");

let prewriteConflict = "";
try {
  await withSetupTransaction(root, "setup", transaction => {
    transaction.capture([file]);
    fs.writeFileSync(file, "external-before-write\n");
    transaction.prepareExpected(file, createHash("sha256").update("desired\n").digest("hex"));
  });
} catch (error: any) { prewriteConflict = error?.code; }
assert(prewriteConflict === "SETUP_TRANSACTION_FAILED", "pre-write CAS must fail closed on an external change");
assert(fs.readFileSync(file, "utf-8") === "external-before-write\n", "pre-write CAS must preserve the external content");
assert(fs.existsSync(projectPaths(root).setupJournal), "an unprepared changed resource must keep its journal for manual recovery");
fs.rmSync(projectPaths(root).setupJournal, { force: true });
fs.writeFileSync(file, "before\n");

let conflictCode = "";
try {
  await withSetupTransaction(root, "setup", transaction => {
    transaction.capture([file]);
    fs.writeFileSync(file, "applied\n");
    transaction.markApplied([file]);
    fs.writeFileSync(file, "external-change\n");
    throw new Error("simulated concurrent mutation");
  });
} catch (error: any) { conflictCode = error?.code; }
assert(conflictCode === "SETUP_TRANSACTION_FAILED", "CAS conflict must return a structured transaction failure");
assert(fs.readFileSync(file, "utf-8") === "external-change\n", "CAS rollback must never overwrite an externally changed resource");
assert(fs.existsSync(projectPaths(root).setupJournal), "CAS conflict must keep its journal for doctor recovery");

const unreadableRoot = makeGitProject("hy-transaction-unreadable-");
const unreadablePaths = projectPaths(unreadableRoot);
fs.mkdirSync(path.dirname(unreadablePaths.setupJournal), { recursive: true });
fs.writeFileSync(unreadablePaths.setupJournal, "{not-json\n", "utf-8");
let unreadableCode = "";
try {
  await withSetupTransaction(unreadableRoot, "setup", () => undefined);
} catch (error: any) { unreadableCode = error?.code; }
assert(unreadableCode === "SETUP_TRANSACTION_FAILED", "an unreadable journal must fail closed");
assert(!fs.existsSync(unreadablePaths.setupLock), "an unreadable journal must not strand the setup lock");
assert(fs.existsSync(unreadablePaths.setupJournal), "an unreadable journal must be preserved for doctor recovery");

console.log("setup-transaction: live-lock grace, WAL crash gap, CAS conflicts, and unreadable-journal cleanup pass");
