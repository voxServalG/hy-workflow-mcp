import { execSync } from "node:child_process";
import { getBaseBranch } from "./state.js";

function run(cmd: string, cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, { cwd, encoding: "utf-8", timeout: 120_000, stdio: ["pipe","pipe","pipe"] });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (e: any) {
    return { ok: false, stdout: e.stdout?.trim() ?? "", stderr: e.stderr?.trim() ?? e.message ?? "" };
  }
}

export function createBranch(root: string, category: string, topic: string): { ok: boolean; branch: string; error?: string } {
  const name = `${category}/${topic}`;
  const base = getBaseBranch(root);
  const r = run(`git checkout -b ${name} origin/${base}`, root);
  if (!r.ok) return { ok: false, branch: name, error: r.stderr };
  return { ok: true, branch: name };
}

export function commitAll(root: string, title: string, body: string): { ok: boolean; hash?: string; error?: string } {
  const r1 = run("git add -A", root);
  if (!r1.ok) return { ok: false, error: r1.stderr };
  const r2 = run(`git commit -m "${title}" -m "${body}"`, root);
  if (!r2.ok) return { ok: false, error: r2.stderr };
  const r3 = run("git rev-parse HEAD", root);
  return { ok: true, hash: r3.stdout };
}

export function push(root: string, branch: string): { ok: boolean; error?: string } {
  const r = run(`git push -u origin ${branch}`, root);
  return { ok: r.ok, error: r.stderr };
}

export function pushForce(root: string, branch: string): { ok: boolean; error?: string } {
  const r = run(`git push --force origin ${branch}`, root);
  return { ok: r.ok, error: r.stderr };
}

export function createPr(root: string, title: string, body: string, baseBranch: string, headBranch: string): { ok: boolean; prNumber?: number; url?: string; error?: string } {
  const r = run(`gh pr create --title "${title}" --body "${body}" --base ${baseBranch} --head ${headBranch}`, root);
  if (!r.ok) return { ok: false, error: r.stderr };
  const match = r.stdout.match(/\/(\d+)$/);
  const prNumber = match ? parseInt(match[1]) : null;
  return { ok: true, prNumber: prNumber ?? 0, url: r.stdout.trim() };
}

export function mergePr(prNumber: number): { ok: boolean; error?: string } {
  const r = run(`gh pr merge ${prNumber} --merge --delete-branch`);
  return { ok: r.ok, error: r.stderr };
}

export function checkCi(prNumber: number): { ok: boolean; allGreen: boolean; checks: Array<{ name: string; conclusion: string }>; error?: string } {
  const r = run(`gh pr view ${prNumber} --json statusCheckRollup`);
  if (!r.ok) return { ok: false, allGreen: false, checks: [], error: r.stderr };
  try {
    const data = JSON.parse(r.stdout);
    const rollup = data.statusCheckRollup ?? [];
    const checks = rollup.map((c: any) => ({
      name: c.name,
      conclusion: c.conclusion ?? "UNKNOWN",
    }));
    const relevant = checks.filter((c: any) => c.conclusion !== "SKIPPED" && c.conclusion !== "NEUTRAL");
    const allGreen = relevant.length > 0 && relevant.every((c: any) => c.conclusion === "SUCCESS");
    return { ok: true, allGreen, checks };
  } catch {
    return { ok: false, allGreen: false, checks: [], error: "Could not parse gh pr view output" };
  }
}

export function checkout(root: string, branch: string): { ok: boolean; error?: string } {
  const r = run(`git checkout ${branch}`, root);
  return { ok: r.ok, error: r.stderr };
}

export function pull(root: string): { ok: boolean; error?: string } {
  const base = getBaseBranch(root);
  const r = run(`git pull origin ${base}`, root);
  return { ok: r.ok, error: r.stderr };
}

export function rebaseDev(root: string): { ok: boolean; error?: string } {
  const base = getBaseBranch(root);
  const r = run(`git rebase origin/${base}`, root);
  return { ok: r.ok, error: r.stderr };
}
