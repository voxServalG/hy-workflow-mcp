import * as fs from "node:fs";
import * as path from "node:path";
import { SetupFailure } from "../setup/types.js";
import { projectPaths, userRoots } from "./user-paths.js";

function canonicalPotential(target: string): string {
  let cursor = path.resolve(target);
  const suffix: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  let base: string;
  try { base = fs.realpathSync.native(cursor); }
  catch (error: any) {
    throw new SetupFailure("preflight", "SETUP_RUNTIME_ROOT_UNSAFE", `Runtime root cannot be resolved safely: ${target}`, "Choose normal OS user config/state/cache directories outside the repository.", { target, cause: error?.message ?? String(error) });
  }
  return path.resolve(base, ...suffix);
}

function inside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertSafeRuntimeBoundary(root: string): void {
  const paths = projectPaths(root);
  const projectRoot = canonicalPotential(paths.identity.root);
  const gitCommonDir = canonicalPotential(paths.identity.gitCommonDir);
  const roots = userRoots();
  const values = Object.entries(roots).map(([name, value]) => ({ name, configured: value, canonical: canonicalPotential(value) }));
  const unsafe = values.filter(item => inside(projectRoot, item.canonical) || inside(gitCommonDir, item.canonical));
  const explicitRoots = [
    "HY_WORKFLOW_CONFIG_HOME", "HY_WORKFLOW_STATE_HOME", "HY_WORKFLOW_CACHE_HOME",
    "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  ].some(name => Boolean(process.env[name]));
  const overlap: Array<{ left: string; right: string; path: string }> = [];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      const a = values[left];
      const b = values[right];
      if (a.canonical === b.canonical || (explicitRoots && (inside(a.canonical, b.canonical) || inside(b.canonical, a.canonical)))) {
        overlap.push({ left: a.name, right: b.name, path: `${a.canonical} <> ${b.canonical}` });
      }
    }
  }
  if (unsafe.length || overlap.length) {
    throw new SetupFailure(
      "preflight",
      "SETUP_RUNTIME_ROOT_UNSAFE",
      "hy-workflow user config/state/cache roots are not safely external to this project.",
      "Unset HY_WORKFLOW_*_HOME/XDG_* overrides or choose distinct OS user directories outside the repository and .git.",
      { projectRoot, gitCommonDir, unsafe, overlap },
    );
  }
}
