import * as path from "node:path";
import picomatch from "picomatch";
import { HyWorkflowError } from "../cli/output.js";

const GLOB_MAGIC = /[*?\[\]{}()!+@]/;

export function normalizeRepositoryPath(value: unknown, label: string, allowGlob: boolean): string {
  if (typeof value !== "string" || !value || value.length > 512) {
    throw new HyWorkflowError("PROTOCOL_PATH_INVALID", `${label} must be a non-empty path of at most 512 characters.`);
  }
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)
    || value.startsWith("./") || value.endsWith("/") || value.startsWith("!")) {
    throw new HyWorkflowError("PROTOCOL_PATH_UNSAFE", `${label} must be a normalized repository-relative POSIX path: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..") || segments[0] === ".git") {
    throw new HyWorkflowError("PROTOCOL_PATH_UNSAFE", `${label} escapes or targets Git internals: ${value}`);
  }
  if (!allowGlob && GLOB_MAGIC.test(value)) {
    throw new HyWorkflowError("PROTOCOL_PATH_INVALID", `${label} must name one literal source file: ${value}`);
  }
  if (allowGlob) {
    if ((value.match(/\*/g) ?? []).length > 32 || (value.match(/\?/g) ?? []).length > 32) {
      throw new HyWorkflowError("PROTOCOL_GLOB_COMPLEX", `${label} contains too many wildcard operators: ${value}`);
    }
    try {
      picomatch.makeRe(value, { dot: true, nonegate: true, noext: true, nobrace: true });
    } catch (error) {
      throw new HyWorkflowError(
        "PROTOCOL_GLOB_INVALID",
        `${label} is not a valid constrained glob: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return segments.join("/");
}
export function absoluteRepositoryPath(root: string, relativePath: string): string {
  const absolute = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HyWorkflowError("PROTOCOL_PATH_UNSAFE", `Path escapes the repository: ${relativePath}`);
  }
  return absolute;
}

export function matchRepositoryPath(relativePath: string, pattern: string): boolean {
  return picomatch(pattern, {
    dot: true,
    nonegate: true,
    noext: true,
    nobrace: true,
  })(relativePath);
}
