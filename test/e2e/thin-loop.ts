import assert from "node:assert/strict";
import { inspectRepository } from "../../src/protocol/inspect.js";
import { verifyEvidence } from "../../src/protocol/verify.js";
import { createRepository, run } from "../helpers/repository.js";

const repo = createRepository();
try {
  repo.write("docs/incidents/INC-PARSER-001.md", [
    "# Parser accepted corrupt input",
    "",
    "Trigger: a truncated record reached the decoder.",
    "Impact: the process accepted incomplete state.",
    "Root cause: the final-length guard was absent.",
    "Resolution: reject records shorter than the declared length.",
    "Regression: test/native/parser-regression.mjs.",
    "Derived invariant: INV-PARSER-001.",
    "",
  ].join("\n"));
  repo.write("docs/invariants/INV-PARSER-001.md", [
    "# Parser length invariant",
    "",
    "Every record must contain all bytes declared by its header.",
    "Source incident: INC-PARSER-001.",
    "Applies to: src/parser/**.",
    "Verification: node test/native/parser-regression.mjs.",
    "",
  ].join("\n"));
  repo.write("src/parser/decode.mjs", "export const complete = value => value.length >= 4;\n");
  repo.write("test/native/parser-regression.mjs", [
    "import assert from 'node:assert/strict';",
    "import { complete } from '../../src/parser/decode.mjs';",
    "assert.equal(complete('abc'), false);",
    "assert.equal(complete('abcd'), true);",
    "",
  ].join("\n"));
  repo.write("hy-workflow.yml", [
    "schema: hy-workflow.protocol.v1",
    "obligations:",
    "  - id: INV-PARSER-001",
    "    kind: invariant",
    "    status: active",
    "    statement: Every decoded record contains all bytes declared by its header.",
    "    sources:",
    "      - docs/incidents/INC-PARSER-001.md",
    "      - docs/invariants/INV-PARSER-001.md",
    "    applies_to:",
    "      paths:",
    "        - src/parser/**",
    "    verification:",
    "      scale: small",
    "      commands:",
    "        - argv: [\"node\", \"test/native/parser-regression.mjs\"]",
    "          expected_exit_code: 0",
    "",
  ].join("\n"));
  repo.commitAll("capture reviewed incident and invariant");

  repo.write("src/parser/decode.mjs", "export const complete = value => value.length >= 4 && !value.includes('!');\n");
  const inspection = inspectRepository(repo.root);
  assert.equal(inspection.status, "issued");
  const command = inspection.commands[0]!;
  const startedAt = new Date().toISOString();
  const execution = run(command.argv[0]!, command.argv.slice(1), repo.root);
  const completedAt = new Date().toISOString();
  const evidence = {
    schema: "hy-workflow.evidence.v1",
    binding: inspection.binding!,
    results: [{
      commandId: command.commandId,
      argv: command.argv,
      startedAt,
      completedAt,
      exitCode: execution.status,
      stdout: execution.stdout,
      stderr: execution.stderr,
    }],
  };
  assert.equal(verifyEvidence(evidence, repo.root).status, "verified");

  repo.write("src/parser/decode.mjs", "export const complete = value => value.length >= 5;\n");
  assert.equal(verifyEvidence(evidence, repo.root).status, "stale");
} finally {
  repo.remove();
}

process.stdout.write("thin incident loop passed\n");
