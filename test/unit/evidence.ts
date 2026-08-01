import assert from "node:assert/strict";
import { inspectRepository } from "../../src/protocol/inspect.js";
import { verifyEvidence } from "../../src/protocol/verify.js";
import { seedProtocolRepository } from "../helpers/repository.js";

const startedAt = "2026-08-01T00:00:00.000Z";
const completedAt = "2026-08-01T00:00:00.100Z";

{
  const repo = seedProtocolRepository();
  try {
    repo.write("src/app.ts", "export const value = 2;\n");
    const inspection = inspectRepository(repo.root);
    assert(inspection.binding);
    const command = inspection.commands[0]!;
    const evidence = {
      schema: "hy-workflow.evidence.v1",
      binding: inspection.binding!,
      results: [{
        commandId: command.commandId,
        argv: command.argv,
        startedAt,
        completedAt,
        exitCode: 0,
        stdout: "v-test\n",
        stderr: "",
      }],
    };
    const verified = verifyEvidence(evidence, repo.root);
    assert.equal(verified.status, "verified");
    assert.equal(verified.trust, "agent_attested");
    assert.equal(verified.results[0]?.stdout.bytes, 7);

    const failed = verifyEvidence({
      ...evidence,
      results: [{ ...evidence.results[0], exitCode: 1 }],
    }, repo.root);
    assert.equal(failed.status, "failed");

    const missing = verifyEvidence({ ...evidence, results: [] }, repo.root);
    assert.equal(missing.status, "missing");

    const wrongArgv = verifyEvidence({
      ...evidence,
      results: [{ ...evidence.results[0], argv: ["node", "--help"] }],
    }, repo.root);
    assert.equal(wrongArgv.status, "invalid");

    repo.write("src/app.ts", "export const value = 4;\n");
    const stale = verifyEvidence(evidence, repo.root);
    assert.equal(stale.status, "stale");
    assert(stale.issues.some(issue => issue.code.includes("DIFF_HASH")));
  } finally { repo.remove(); }
}

process.stdout.write("evidence unit tests passed\n");
