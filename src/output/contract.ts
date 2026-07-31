export const OUTPUT_CONTROL_FIELDS = [
  "ok",
  "phase",
  "next",
  "stage",
  "status",
  "nextAction",
  "control",
  "userAction",
  "data",
  "error",
  "display",
  "summary",
  "hint",
  "requires_user",
  "stop_here",
  "allowedTools",
  "blockedTools",
  "recovery",
  "checks",
  "findings",
  "pagination",
  "meta",
  "_notice",
] as const;

export const DISPLAY_FIELDS = ["title", "body", "files", "urls"] as const;
export const RECOVERY_FIELDS = ["strategy", "tool", "arguments", "command", "instruction", "byLayer"] as const;
export const PAGINATION_FIELDS = ["has_more", "page_token", "next_page_token"] as const;
export const META_FIELDS = ["command", "cwd", "identity", "format", "version", "request_id", "trace_id", "duration_ms"] as const;
export const NOTICE_FIELDS = ["update"] as const;
export const NOTICE_UPDATE_FIELDS = ["message", "command", "current_version", "latest_version"] as const;
export const NEXT_ACTION_FIELDS = ["tool", "arguments", "phase", "stage", "automatic"] as const;
export const CONTROL_FIELDS = ["automatic", "stop", "reason"] as const;
export const USER_ACTION_FIELDS = ["kind", "decisionId", "prompt", "instruction", "options"] as const;

export const ERROR_ENVELOPE_FIELDS = [
  "type",
  "subtype",
  "code",
  "message",
  "hint",
  "detail",
  "cause",
  "retryable",
  "risk",
  "permission_violations",
  "missing_scopes",
  "console_url",
  "request_id",
  "trace_id",
] as const;

export type OutputControlField = typeof OUTPUT_CONTROL_FIELDS[number];
export type ErrorEnvelopeField = typeof ERROR_ENVELOPE_FIELDS[number];

// Sections that hy_plan requires agents to display to users in full.
// Each section has an anchor (markdown heading prefix) and a label.
export const REQUIRED_SECTIONS = [
  { anchor: "## Plan",     label: "一句话：现状 → 期望" },
  { anchor: "> **为什么**", label: "为什么要改" },
  { anchor: "### 改动",     label: "改什么文件" },
  { anchor: "> **影响**",   label: "影响谁" },
  { anchor: "### 验证",     label: "验证清单" },
  { anchor: "### 风险",     label: "风险和缓解" },
] as const;
