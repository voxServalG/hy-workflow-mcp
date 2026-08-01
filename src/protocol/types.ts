import type { CliIssue } from "../cli/output.js";
import type { GitChange } from "../git/snapshot.js";

export type VerificationScale = "small" | "medium" | "large";
export type ObligationKind = "invariant" | "incident";
export type ObligationStatus = "active" | "superseded" | "retired";

export type VerificationCommand = {
  argv: string[];
  expectedExitCode: number;
};
export type ProtocolObligation = {
  id: string;
  kind: ObligationKind;
  status: ObligationStatus;
  statement: string;
  sources: string[];
  appliesTo: string[];
  scale: VerificationScale;
  commands: VerificationCommand[];
  supersededBy?: string;
};

export type ProtocolDocument = {
  schema: "hy-workflow.protocol.v1";
  obligations: ProtocolObligation[];
};

export type IssuedCommand = VerificationCommand & {
  commandId: string;
  obligationIds: string[];
};

export type IssuedObligation = {
  id: string;
  kind: ObligationKind;
  statement: string;
  sources: string[];
  matchedPaths: string[];
  scale: VerificationScale;
  commandIds: string[];
};

export type InspectionBinding = {
  issuanceId: string;
  head: string;
  diffHash: string;
  protocolHash: string;
};

export type InspectionEnvelope = {
  schema: "hy-workflow.inspect.v1";
  version: 1;
  command: "inspect";
  ok: boolean;
  status: "issued" | "no_match" | "unavailable" | "invalid";
  repository: {
    root: string | null;
    head: string | null;
    diffHash: string | null;
    protocolPath: string | null;
    protocolHash: string | null;
  };
  changes: GitChange[];
  obligations: IssuedObligation[];
  commands: IssuedCommand[];
  binding: InspectionBinding | null;
  issues: CliIssue[];
};
