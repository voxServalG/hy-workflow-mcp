import type { Phase } from "../runtime/state-machine.js";
import { structuredError, type StructuredError } from "../errs/structured.js";

export type ToolResult = {
  next: Phase;
  ok?: boolean;
  phase?: Phase;
  error?: StructuredError;
  display?: {
    title?: string;
    body?: string;
    files?: string[];
    urls?: string[];
  };
  hint?: string;
  requires_user?: boolean;
  stop_here?: boolean;
  allowedTools?: string[];
  blockedTools?: string[];
  recovery?: {
    tool?: string;
    instruction?: string;
    byLayer?: Record<string, string>;
  };
  [key: string]: any;
};

export function toolResult(next: Phase, fields: Omit<ToolResult, "next"> = {}): ToolResult {
  const error = fields.error === undefined ? undefined : structuredError(fields.error);
  return {
    ok: fields.ok ?? error === undefined,
    phase: fields.phase ?? next,
    next,
    ...fields,
    ...(error ? { error } : {}),
  };
}

export function structuredFailureResult(next: Phase, error: unknown, fields: Omit<ToolResult, "next" | "error" | "ok"> = {}): ToolResult {
  return toolResult(next, { ...fields, ok: false, error: structuredError(error) });
}

