import { execSync } from "node:child_process";
import { getBaseBranch } from "./state.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
function run(cmd, cwd) {
    try {
        const stdout = execSync(cmd, { cwd, encoding: "utf-8", timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] });
        return { ok: true, stdout: stdout.trim(), stderr: "" };
    }
    catch (e) {
        return { ok: false, stdout: e.stdout?.trim() ?? "", stderr: e.stderr?.trim() ?? e.message ?? "" };
    }
}
function writeTempFile(content) {
    const tmpPath = path.join(os.tmpdir(), `hy-commit-${Date.now()}.txt`);
    fs.writeFileSync(tmpPath, content, "utf-8");
    return tmpPath;
}
export function createBranch(root, category, topic) {
    const name = `${category}/${topic}`;
    const base = getBaseBranch(root);
    const r = run(`git checkout -b ${name} origin/${base}`, root);
    if (!r.ok)
        return { ok: false, branch: name, error: r.stderr };
    return { ok: true, branch: name };
}
export function commitAll(root, title, body) {
    const r1 = run("git add -A", root);
    if (!r1.ok)
        return { ok: false, error: r1.stderr };
    const msgFile = writeTempFile(`${title}\n\n${body}`);
    try {
        const r2 = run(`git commit -F "${msgFile}"`, root);
        if (!r2.ok)
            return { ok: false, error: r2.stderr };
        const r3 = run("git rev-parse HEAD", root);
        return { ok: true, hash: r3.stdout };
    }
    finally {
        fs.unlinkSync(msgFile);
    }
}
export function push(root, branch) {
    const r = run(`git push -u origin ${branch}`, root);
    return { ok: r.ok, error: r.stderr };
}
export function pushForce(root, branch) {
    const r = run(`git push --force origin ${branch}`, root);
    return { ok: r.ok, error: r.stderr };
}
export function createPr(root, title, body, baseBranch, headBranch) {
    const bodyFile = writeTempFile(body);
    try {
        const r = run(`gh pr create --title "${title}" --body-file "${bodyFile}" --base ${baseBranch} --head ${headBranch}`, root);
        if (!r.ok)
            return { ok: false, error: r.stderr };
        const match = r.stdout.match(/\/(\d+)$/);
        const prNumber = match ? parseInt(match[1]) : null;
        return { ok: true, prNumber: prNumber ?? 0, url: r.stdout.trim() };
    }
    finally {
        fs.unlinkSync(bodyFile);
    }
}
export function mergePr(prNumber) {
    const r = run(`gh pr merge ${prNumber} --merge --delete-branch`);
    return { ok: r.ok, error: r.stderr };
}
export function checkCi(prNumber) {
    const r = run(`gh pr view ${prNumber} --json statusCheckRollup`);
    if (!r.ok)
        return { ok: false, allGreen: false, checks: [], error: r.stderr };
    try {
        const data = JSON.parse(r.stdout);
        const rollup = data.statusCheckRollup ?? [];
        const checks = rollup.map((c) => ({
            name: c.name,
            conclusion: c.conclusion ?? "UNKNOWN",
        }));
        const relevant = checks.filter((c) => c.conclusion !== "SKIPPED" && c.conclusion !== "NEUTRAL");
        const allGreen = relevant.length > 0 && relevant.every((c) => c.conclusion === "SUCCESS");
        return { ok: true, allGreen, checks };
    }
    catch {
        return { ok: false, allGreen: false, checks: [], error: "Could not parse gh pr view output" };
    }
}
export function checkout(root, branch) {
    const r = run(`git checkout ${branch}`, root);
    return { ok: r.ok, error: r.stderr };
}
export function pull(root) {
    const base = getBaseBranch(root);
    const r = run(`git pull origin ${base}`, root);
    return { ok: r.ok, error: r.stderr };
}
export function rebaseDev(root) {
    const base = getBaseBranch(root);
    const r = run(`git rebase origin/${base}`, root);
    return { ok: r.ok, error: r.stderr };
}
//# sourceMappingURL=git.js.map