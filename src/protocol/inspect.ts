import { createHash } from "node:crypto";
import { stableJsonStringify } from "../cli/input.js";
import { issueFromError } from "../cli/output.js";
import { findRepositoryRoot } from "../git/repository.js";
import { captureStableSnapshot } from "../git/snapshot.js";
import { loadProtocol, PROTOCOL_FILE } from "./load.js";
import { matchRepositoryPath } from "./paths.js";
import type {
  InspectionEnvelope,
  IssuedCommand,
  IssuedObligation,
  ProtocolObligation,
  VerificationCommand,
} from "./types.js";

function commandIdentity(command: VerificationCommand): string {
  return createHash("sha256")
    .update(stableJsonStringify({ argv: command.argv, expectedExitCode: command.expectedExitCode }))
    .digest("hex");
}
function issueObligations(
  obligations: ProtocolObligation[],
  changedPaths: string[],
): { obligations: IssuedObligation[]; commands: IssuedCommand[] } {
  const commandByHash = new Map<string, IssuedCommand>();
  const issued: IssuedObligation[] = [];
  for (const obligation of obligations.filter(item => item.status === "active").sort((a, b) => a.id.localeCompare(b.id))) {
    const matchedPaths = changedPaths.filter(changedPath =>
      obligation.appliesTo.some(pattern => matchRepositoryPath(changedPath, pattern)));
    if (!matchedPaths.length) continue;
    const commandIds: string[] = [];
    for (const command of obligation.commands) {
      const hash = commandIdentity(command);
      const commandId = `cmd-${hash.slice(0, 20)}`;
      const existing = commandByHash.get(hash);
      if (existing) {
        if (!existing.obligationIds.includes(obligation.id)) existing.obligationIds.push(obligation.id);
      } else {
        commandByHash.set(hash, {
          commandId,
          argv: [...command.argv],
          expectedExitCode: command.expectedExitCode,
          obligationIds: [obligation.id],
        });
      }
      commandIds.push(commandId);
    }
    issued.push({
      id: obligation.id,
      kind: obligation.kind,
      statement: obligation.statement,
      sources: [...obligation.sources].sort(),
      matchedPaths: [...matchedPaths].sort(),
      scale: obligation.scale,
      commandIds: [...new Set(commandIds)].sort(),
    });
  }
  const commands = [...commandByHash.values()]
    .map(command => ({ ...command, obligationIds: command.obligationIds.sort() }))
    .sort((left, right) => left.commandId.localeCompare(right.commandId));
  return { obligations: issued, commands };
}

function unavailable(error: unknown, root: string | null = null): InspectionEnvelope {
  const issue = issueFromError(error);
  const invalid = issue.code.startsWith("PROTOCOL_") && issue.code !== "PROTOCOL_NOT_FOUND";
  return {
    schema: "hy-workflow.inspect.v1",
    version: 1,
    command: "inspect",
    ok: !invalid,
    status: invalid ? "invalid" : "unavailable",
    repository: {
      root,
      head: null,
      diffHash: null,
      protocolPath: root ? `${root}/${PROTOCOL_FILE}` : null,
      protocolHash: null,
    },
    changes: [],
    obligations: [],
    commands: [],
    binding: null,
    issues: [issue],
  };
}

export function inspectRepository(cwd = process.cwd()): InspectionEnvelope {
  let root: string;
  try {
    root = findRepositoryRoot(cwd);
  } catch (error) {
    return unavailable(error);
  }
  try {
    const protocol = loadProtocol(root);
    const snapshot = captureStableSnapshot(root);
    const issued = issueObligations(protocol.document.obligations, snapshot.changedPaths);
    const issuanceId = createHash("sha256").update(stableJsonStringify({
      schema: "hy-workflow.issuance.v1",
      head: snapshot.head,
      diffHash: snapshot.diffHash,
      protocolHash: protocol.hash,
      obligations: issued.obligations,
      commands: issued.commands,
    })).digest("hex");
    return {
      schema: "hy-workflow.inspect.v1",
      version: 1,
      command: "inspect",
      ok: true,
      status: issued.obligations.length ? "issued" : "no_match",
      repository: {
        root,
        head: snapshot.head,
        diffHash: snapshot.diffHash,
        protocolPath: protocol.path,
        protocolHash: protocol.hash,
      },
      changes: snapshot.changes,
      obligations: issued.obligations,
      commands: issued.commands,
      binding: { issuanceId, head: snapshot.head, diffHash: snapshot.diffHash, protocolHash: protocol.hash },
      issues: [],
    };
  } catch (error) {
    return unavailable(error, root);
  }
}
