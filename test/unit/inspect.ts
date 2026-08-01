import assert from "node:assert/strict";
import { inspectRepository } from "../../src/protocol/inspect.js";
import { baseProtocol, seedProtocolRepository } from "../helpers/repository.js";

{
  const repo = seedProtocolRepository();
  try {
    const clean = inspectRepository(repo.root);
    assert.equal(clean.status, "no_match");
    assert.deepEqual(clean.obligations, []);

    repo.write("src/app.ts", "export const value = 2;\n");
    const first = inspectRepository(repo.root);
    const second = inspectRepository(repo.root);
    assert.equal(first.status, "issued");
    assert.equal(first.obligations[0]?.id, "INV-TEST-001");
    assert.deepEqual(first.obligations[0]?.matchedPaths, ["src/app.ts"]);
    assert.equal(first.binding?.issuanceId, second.binding?.issuanceId);
  } finally { repo.remove(); }
}

{
  const repo = seedProtocolRepository(baseProtocol({ second: true }));
  try {
    repo.write("src/app.ts", "export const value = 3;\n");
    const inspection = inspectRepository(repo.root);
    assert.equal(inspection.obligations.length, 2);
    assert.equal(inspection.commands.length, 1, "identical native commands must be issued once");
    assert.deepEqual(inspection.commands[0]?.obligationIds, ["INV-TEST-001", "INV-TEST-002"]);
  } finally { repo.remove(); }
}

{
  const repo = seedProtocolRepository();
  try {
    repo.git("mv", "src/app.ts", "src/moved.ts");
    repo.write("src/staged.ts", "export const staged = true;\n");
    repo.git("add", "src/staged.ts");
    repo.write("src/untracked.ts", "export const untracked = true;\n");
    const inspection = inspectRepository(repo.root);
    const paths = [...new Set(inspection.changes.flatMap(change => change.paths))];
    assert(paths.includes("src/app.ts"));
    assert(paths.includes("src/moved.ts"));
    assert(paths.includes("src/staged.ts"));
    assert(paths.includes("src/untracked.ts"));
  } finally { repo.remove(); }
}

process.stdout.write("inspect unit tests passed\n");
