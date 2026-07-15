import type { ClientName, DeploymentMode } from "../runtime/deployment.js";

export type SetupAction = "setup" | "unset";
export type SetupLanguage = "zh" | "en";
export type ServerName = "hy-workflow" | "docs-gardener";

export type McpDefinition = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type ClientDetection = {
  name: ClientName;
  installed: boolean;
  executable: string | null;
  version: string | null;
  configured: ServerName[];
  error?: string;
};

export type ClientServerSnapshot = {
  definition: McpDefinition | null;
  raw?: unknown;
};

export type ClientAdapter = {
  name: ClientName;
  detect(): ClientDetection;
  inspect(server: ServerName): ClientServerSnapshot;
  install(server: ServerName, definition: McpDefinition): ClientServerSnapshot;
  remove(server: ServerName, expected: McpDefinition, previous?: ClientServerSnapshot | null): void;
};

export type SetupOptions = {
  action: SetupAction;
  mode: DeploymentMode;
  clients: ClientName[];
  language: SetupLanguage;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  removeGlobal: boolean;
};

export type SetupResult = {
  ok: boolean;
  action: SetupAction;
  mode: DeploymentMode;
  projectId: string;
  projectRoot: string;
  clients: Array<{ name: ClientName; status: "configured" | "removed" | "kept" | "skipped"; detail?: string }>;
  projectFilesChanged: string[];
  localFilesChanged: string[];
  remainingProjects?: number;
  dryRun: boolean;
  message: string;
  recovery?: string[];
};

export const MCP_DEFINITIONS: Record<ServerName, McpDefinition> = {
  "hy-workflow": { command: "hy-workflow", args: [] },
  "docs-gardener": { command: "docs-gardener", args: ["mcp"] },
};
