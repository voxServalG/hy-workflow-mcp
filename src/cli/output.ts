export type CliIssue = {
  code: string;
  message: string;
  path?: string;
};

export class HyWorkflowError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = "HyWorkflowError";
    this.code = code;
    this.path = path;
  }
}

export function issueFromError(error: unknown): CliIssue {
  if (error instanceof HyWorkflowError) {
    return { code: error.code, message: error.message, ...(error.path ? { path: error.path } : {}) };
  }
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    return {
      code: String((error as { code: unknown }).code),
      message: String((error as { message: unknown }).message),
    };
  }
  return { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
