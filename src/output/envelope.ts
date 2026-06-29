import type { Phase } from "../runtime/state-machine.js";
import { structuredError, type StructuredError } from "../errs/structured.js";

export type ToolDisplay = {
  title?: string;
  body?: string;
  files?: string[];
  urls?: string[];
};

export type ToolRecovery = {
  tool?: string;
  command?: string;
  instruction?: string;
  byLayer?: Record<string, string>;
};

export type ToolPagination = {
  has_more?: boolean;
  page_token?: string;
  next_page_token?: string;
};

export type ToolMeta = {
  command?: string;
  cwd?: string;
  identity?: string;
  format?: string;
  version?: string;
  request_id?: string;
  trace_id?: string;
  duration_ms?: number;
  [key: string]: unknown;
};

export type ToolNotice = {
  update?: {
    message?: string;
    command?: string;
    current_version?: string;
    latest_version?: string;
  };
  [key: string]: unknown;
};

export type ToolResult = {
  next: Phase;
  ok?: boolean;
  phase?: Phase;
  status?: string;
  data?: unknown;
  error?: StructuredError;
  display?: ToolDisplay;
  summary?: string;
  hint?: string;
  requires_user?: boolean;
  stop_here?: boolean;
  allowedTools?: string[];
  blockedTools?: string[];
  recovery?: ToolRecovery;
  checks?: unknown[];
  findings?: unknown[];
  pagination?: ToolPagination;
  meta?: ToolMeta;
  _notice?: ToolNotice;
  [key: string]: any;
};

export type ToolResultFields = Omit<ToolResult, "next" | "error"> & {
  error?: unknown;
};

export function toolResult(next: Phase, fields: ToolResultFields = {}): ToolResult {
  const { error: rawError, ...rest } = fields;
  const error = rawError === undefined ? undefined : structuredError(rawError);
  return {
    ok: rest.ok ?? error === undefined,
    phase: rest.phase ?? next,
    next,
    ...rest,
    ...(error ? { error } : {}),
  };
}

export function structuredFailureResult(next: Phase, error: unknown, fields: Omit<ToolResultFields, "error" | "ok"> = {}): ToolResult {
  return toolResult(next, { ...fields, ok: false, error: structuredError(error) });
}
