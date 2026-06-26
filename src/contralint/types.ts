export type ContractSeverity = "hard_fail" | "amend_required" | "warning";

export type ContractFinding = {
  rule: string;
  severity: ContractSeverity;
  message: string;
  file?: string;
  detail?: unknown;
};

export type ContractRuleContext = {
  root: string;
};

export type ContractRule = {
  name: string;
  run(context: ContractRuleContext): ContractFinding[];
};

export type ContractLintReport = {
  ok: boolean;
  status: "passed" | "hard_fail" | "amend_required" | "warning";
  counts: Record<ContractSeverity, number>;
  findings: ContractFinding[];
};

