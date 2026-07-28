export type InternalSetupTestHooks = {
  failAt?: string;
  ownerDelayMs?: number;
  skipHandshake?: boolean;
  beforeLockedPreflight?: (root: string) => void;
  afterSetupPreflightBeforeLock?: (root: string) => void | Promise<void>;
  afterLockedPreflight?: (root: string) => void;
  afterUnsetPreflightBeforeLock?: (root: string) => void | Promise<void>;
  failDirectoryCleanup?: boolean;
  afterDirectoryStage?: (target: string) => void;
  afterUnsetRegistryWrite?: () => void;
  beforeDirectoryCleanup?: (tombstone: string) => void;
  afterClientCommandBeforeJournal?: (client: string, server: string) => void;
};

const KEY = Symbol.for("@voxstudio/hy-workflow/internal-setup-test-hooks");

export function internalSetupTestHooks(): InternalSetupTestHooks {
  return ((globalThis as any)[KEY] ?? {}) as InternalSetupTestHooks;
}
