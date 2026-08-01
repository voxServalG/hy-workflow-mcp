import assert from "node:assert/strict";
import { loadProtocol } from "../../src/protocol/load.js";
import { baseProtocol, seedProtocolRepository } from "../helpers/repository.js";

{
  const repo = seedProtocolRepository();
  try {
    const loaded = loadProtocol(repo.root);
    assert.equal(loaded.document.schema, "hy-workflow.protocol.v1");
    assert.equal(loaded.document.obligations.length, 1);
    assert.match(loaded.hash, /^[0-9a-f]{64}$/);
  } finally { repo.remove(); }
}

{
  const repo = seedProtocolRepository();
  try {
    repo.write("hy-workflow.yml", "schema: hy-workflow.protocol.v1\nschema: duplicate\nobligations: []\n");
    assert.throws(() => loadProtocol(repo.root), /Map keys must be unique|Invalid hy-workflow\.yml/);
  } finally { repo.remove(); }
}

{
  const repo = seedProtocolRepository(baseProtocol({ second: true }));
  try {
    repo.write("hy-workflow.yml", baseProtocol({ second: true }).replace("INV-TEST-002", "INV-TEST-001"));
    assert.throws(() => loadProtocol(repo.root), /obligation id must be unique/i);
  } finally { repo.remove(); }
}

{
  const repo = seedProtocolRepository();
  try {
    repo.write("hy-workflow.yml", baseProtocol().replace("src/**", "../outside/**"));
    assert.throws(() => loadProtocol(repo.root), /escapes|normalized repository-relative|unsafe/i);
  } finally { repo.remove(); }
}

{
  const repo = seedProtocolRepository();
  try {
    repo.write("hy-workflow.yml", baseProtocol({ argv: ["bash", "-c", "npm test"] }));
    assert.throws(() => loadProtocol(repo.root), /shell command string/i);
  } finally { repo.remove(); }
}

{
  const repo = seedProtocolRepository();
  try {
    repo.write("docs/invariants/INV-NEW-001.md", "# Draft\n");
    repo.write("hy-workflow.yml", baseProtocol({ source: "docs/invariants/INV-NEW-001.md" }));
    assert.throws(() => loadProtocol(repo.root), /must be tracked in Git/);
  } finally { repo.remove(); }
}

process.stdout.write("protocol unit tests passed\n");
