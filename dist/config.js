import * as fs from "node:fs";
import * as path from "node:path";
const CONFIG_FILES = ["codelint.json", "doclint.json", "docs-gardener.json"];
function exists(root, rel) {
    return fs.existsSync(path.join(root, rel));
}
function readJson(root, rel) {
    const filePath = path.join(root, rel);
    if (!fs.existsSync(filePath))
        return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}
function writeJson(root, rel, value) {
    const filePath = path.join(root, rel);
    const next = JSON.stringify(value, null, 2) + "\n";
    const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
    if (prev === next)
        return false;
    fs.writeFileSync(filePath, next, "utf-8");
    return true;
}
function listFiles(root, dir, ext) {
    const start = path.join(root, dir);
    if (!fs.existsSync(start))
        return [];
    const out = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist")
                continue;
            const full = path.join(current, entry.name);
            if (entry.isDirectory())
                walk(full);
            else if (entry.name.endsWith(ext))
                out.push(full);
        }
    };
    walk(start);
    return out;
}
function existingDirs(root, candidates) {
    return candidates.filter(dir => {
        try {
            return fs.statSync(path.join(root, dir)).isDirectory();
        }
        catch {
            return false;
        }
    });
}
export function detectProject(root) {
    const evidence = [];
    const pyMarkers = ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"].filter(item => exists(root, item));
    const tsMarkers = ["tsconfig.json", "package.json"].filter(item => exists(root, item));
    const dirs = existingDirs(root, ["src", "tests", "scripts", "lib", "packages"]);
    const pyCount = dirs.reduce((sum, dir) => sum + listFiles(root, dir, ".py").length, 0);
    const tsCount = dirs.reduce((sum, dir) => sum + listFiles(root, dir, ".ts").length, 0);
    if (pyMarkers.length)
        evidence.push(`python markers: ${pyMarkers.join(", ")}`);
    if (tsMarkers.length)
        evidence.push(`typescript markers: ${tsMarkers.join(", ")}`);
    if (pyCount)
        evidence.push(`python files: ${pyCount}`);
    if (tsCount)
        evidence.push(`typescript files: ${tsCount}`);
    const pyScore = pyMarkers.length * 3 + pyCount;
    const tsScore = tsMarkers.length * 3 + tsCount;
    if (pyScore > 0 && tsScore > 0) {
        if (pyScore >= tsScore * 2)
            return { kind: "python", evidence };
        if (tsScore >= pyScore * 2)
            return { kind: "typescript", evidence };
        return { kind: "mixed", evidence };
    }
    if (pyScore > 0)
        return { kind: "python", evidence };
    if (tsScore > 0)
        return { kind: "typescript", evidence };
    return { kind: "unknown", evidence };
}
function inferDirs(root, ext) {
    const dirs = existingDirs(root, ["src", "tests", "scripts", "lib", "packages"]);
    const withFiles = dirs.filter(dir => listFiles(root, dir, ext).length > 0);
    if (withFiles.length)
        return withFiles;
    if (exists(root, "src"))
        return ["src"];
    return ["src"];
}
export function defaultSuggestion(root) {
    const detected = detectProject(root);
    const codeExt = detected.kind === "python" ? ".py" : ".ts";
    const codeDirs = inferDirs(root, codeExt);
    return {
        codeExt,
        codeDirs,
        lintDirs: codeDirs,
        docsDir: exists(root, "docs") ? "docs" : "docs",
        baseBranch: "dev",
        maxCodeLines: 500,
        maxDocLines: 200,
    };
}
function mergeSuggestion(root, explicit) {
    return { ...defaultSuggestion(root), ...explicit };
}
function codelintConfig(existing, suggestion, preserveExisting) {
    if (preserveExisting) {
        return {
            lintDirs: existing?.lintDirs ?? suggestion.lintDirs,
            codeDirs: existing?.codeDirs ?? suggestion.codeDirs,
            codeExt: existing?.codeExt ?? suggestion.codeExt,
            baseBranch: existing?.baseBranch ?? suggestion.baseBranch,
            maxLines: existing?.maxLines ?? suggestion.maxCodeLines,
            ...(existing ?? {}),
        };
    }
    return {
        ...(existing ?? {}),
        lintDirs: suggestion.lintDirs,
        codeDirs: suggestion.codeDirs,
        codeExt: suggestion.codeExt,
        baseBranch: suggestion.baseBranch,
        maxLines: suggestion.maxCodeLines,
    };
}
function doclintConfig(existing, suggestion, preserveExisting) {
    if (preserveExisting) {
        return {
            docsDir: existing?.docsDir ?? suggestion.docsDir,
            codeDirs: existing?.codeDirs ?? suggestion.codeDirs,
            codeExt: existing?.codeExt ?? suggestion.codeExt,
            baseBranch: existing?.baseBranch ?? suggestion.baseBranch,
            maxLines: existing?.maxLines ?? suggestion.maxDocLines,
            ...(existing ?? {}),
        };
    }
    return {
        ...(existing ?? {}),
        docsDir: suggestion.docsDir,
        codeDirs: suggestion.codeDirs,
        codeExt: suggestion.codeExt,
        baseBranch: suggestion.baseBranch,
        maxLines: suggestion.maxDocLines,
    };
}
function gardenerConfig(existing, suggestion, preserveExisting) {
    if (preserveExisting) {
        return {
            docsDir: existing?.docsDir ?? suggestion.docsDir,
            codeDirs: existing?.codeDirs ?? suggestion.codeDirs,
            codeExt: existing?.codeExt ?? suggestion.codeExt,
            baseBranch: existing?.baseBranch ?? suggestion.baseBranch,
            catalogs: existing?.catalogs ?? {},
            ...(existing ?? {}),
        };
    }
    return {
        ...(existing ?? {}),
        docsDir: suggestion.docsDir,
        codeDirs: suggestion.codeDirs,
        codeExt: suggestion.codeExt,
        baseBranch: suggestion.baseBranch,
        catalogs: existing?.catalogs ?? {},
    };
}
export function ensureConfigDefaults(root, options = {}) {
    const suggestion = defaultSuggestion(root);
    return applyConfig(root, suggestion, { preserveExisting: true, dryRun: options.dryRun ?? false, mode: "setup" });
}
function preservedKeys(before, after) {
    if (!before)
        return Object.keys(after);
    return Object.keys(before).filter(key => JSON.stringify(before[key]) === JSON.stringify(after[key]));
}
export function applyConfig(root, suggestion, options) {
    const before = {
        "codelint.json": readJson(root, "codelint.json"),
        "doclint.json": readJson(root, "doclint.json"),
        "docs-gardener.json": readJson(root, "docs-gardener.json"),
    };
    const effective = suggestion;
    const after = {
        "codelint.json": codelintConfig(before["codelint.json"], effective, options.preserveExisting),
        "doclint.json": doclintConfig(before["doclint.json"], effective, options.preserveExisting),
        "docs-gardener.json": gardenerConfig(before["docs-gardener.json"], effective, options.preserveExisting),
    };
    const changed = [];
    const preserved = {};
    for (const file of CONFIG_FILES) {
        const prev = before[file];
        const next = after[file];
        if (JSON.stringify(prev) !== JSON.stringify(next))
            changed.push(file);
        preserved[file] = preservedKeys(prev, next);
        if (!options.dryRun)
            writeJson(root, file, next);
    }
    const result = checkConfig(root, suggestion);
    return {
        ...result,
        ok: true,
        changed,
        preserved,
        dryRun: options.dryRun,
        display: {
            title: options.dryRun ? "Config dry run complete" : "Config updated",
            body: `${options.dryRun ? "Would update" : "Updated"} ${changed.length ? changed.join(", ") : "no config files"} while preserving existing values by default.`,
        },
        hint: "Rerun hy_init after applying config changes so setup artifacts and workflow state can be validated.",
    };
}
function valueArray(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}
export function checkConfig(root, suggestion = defaultSuggestion(root)) {
    const project = detectProject(root);
    const issues = [];
    const codelint = readJson(root, "codelint.json");
    const doclint = readJson(root, "doclint.json");
    const gardener = readJson(root, "docs-gardener.json");
    if (!codelint)
        issues.push("Missing codelint.json");
    if (!doclint)
        issues.push("Missing doclint.json");
    if (!gardener)
        issues.push("Missing docs-gardener.json");
    const expectedExt = project.kind === "python" ? ".py" : project.kind === "typescript" ? ".ts" : null;
    if (expectedExt && codelint?.codeExt && codelint.codeExt !== expectedExt)
        issues.push(`codelint.json codeExt=${codelint.codeExt} but project appears ${project.kind}`);
    for (const [file, config] of Object.entries({ "doclint.json": doclint, "docs-gardener.json": gardener })) {
        if (!config)
            continue;
        if (expectedExt && config.codeExt && config.codeExt !== expectedExt)
            issues.push(`${file} codeExt=${config.codeExt} but project appears ${project.kind}`);
        if (config.docsDir && !exists(root, config.docsDir))
            issues.push(`${file} docsDir does not exist: ${config.docsDir}`);
        for (const dir of valueArray(config.codeDirs)) {
            if (!exists(root, dir))
                issues.push(`${file} codeDirs entry does not exist: ${dir}`);
        }
    }
    if (doclint && gardener && JSON.stringify(doclint.codeDirs) !== JSON.stringify(gardener.codeDirs))
        issues.push("doclint.json codeDirs differs from docs-gardener.json codeDirs");
    if (doclint && gardener && doclint.docsDir !== gardener.docsDir)
        issues.push("doclint.json docsDir differs from docs-gardener.json docsDir");
    const ambiguous = project.kind === "mixed" || project.kind === "unknown";
    const suggestedCommand = buildSuggestedCommand(suggestion, ambiguous);
    const ok = issues.length === 0 && !ambiguous;
    return {
        ok,
        phase: "config",
        next: "config",
        display: {
            title: ok ? "Config looks consistent" : "Project config needs confirmation",
            body: ok
                ? "codelint/doclint/docs-gardener configuration matches the detected project shape."
                : `${issues.length ? issues.join("\n") : `Project type is ${project.kind}; explicit confirmation is required.`}\n\nSuggested command:\n${suggestedCommand}`,
        },
        hint: ok ? "Continue with hy_init or the requested workflow task." : "Show display.body and run the suggested config command only after user approval.",
        requires_user: ok ? false : true,
        stop_here: ok ? false : true,
        allowedTools: ok ? ["hy_init", "hy_status"] : ["terminal", "hy_init", "hy_status"],
        recovery: ok ? undefined : { tool: "terminal", instruction: suggestedCommand },
        project,
        issues,
        suggestion,
        suggestedCommand,
    };
}
function quoteArg(value) {
    return value.includes(" ") ? `'${value.replace(/'/g, `'\\''`)}'` : value;
}
export function buildSuggestedCommand(suggestion, needsExplicit = false) {
    const mode = needsExplicit ? " --dry-run" : " --apply-suggested";
    return [
        "npx -y --prefer-online github:voxServalG/hy-workflow-mcp config",
        mode.trim(),
        "--json",
        "--code-ext", quoteArg(suggestion.codeExt),
        "--code-dirs", quoteArg(suggestion.codeDirs.join(",")),
        "--lint-dirs", quoteArg(suggestion.lintDirs.join(",")),
        "--docs-dir", quoteArg(suggestion.docsDir),
        "--base-branch", quoteArg(suggestion.baseBranch),
    ].join(" ");
}
function parseList(value) {
    return value ? value.split(",").map(item => item.trim()).filter(Boolean) : undefined;
}
function parseArgs(argv) {
    const args = { mode: "check", json: false, dryRun: false, applySuggested: false, explicit: {} };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => argv[++i];
        if (arg === "--help" || arg === "-h")
            args.mode = "help";
        else if (arg === "--json")
            args.json = true;
        else if (arg === "--check")
            args.mode = "check";
        else if (arg === "--dry-run")
            args.dryRun = true;
        else if (arg === "--apply" || arg === "--apply-suggested") {
            args.mode = "apply";
            args.applySuggested = true;
        }
        else if (arg === "--python")
            args.explicit.codeExt = ".py";
        else if (arg === "--typescript")
            args.explicit.codeExt = ".ts";
        else if (arg === "--code-ext")
            args.explicit.codeExt = next();
        else if (arg === "--code-dirs")
            args.explicit.codeDirs = parseList(next());
        else if (arg === "--lint-dirs")
            args.explicit.lintDirs = parseList(next());
        else if (arg === "--docs-dir")
            args.explicit.docsDir = next();
        else if (arg === "--base-branch")
            args.explicit.baseBranch = next();
    }
    if (args.dryRun)
        args.mode = "apply";
    return args;
}
export function configHelp() {
    return [
        "hy-workflow-mcp",
        "",
        "Usage:",
        "  hy-workflow                 Start MCP stdio server",
        "  hy-workflow --help          Show this help",
        "  hy-workflow config --check --json",
        "  hy-workflow config --apply-suggested --json",
        "  hy-workflow config --python --code-dirs src,tests --docs-dir docs --base-branch dev --json",
        "",
        "Config commands emit a single JSON envelope when --json is passed.",
    ].join("\n");
}
export function runConfigCli(argv, root = process.cwd()) {
    const args = parseArgs(argv);
    if (args.mode === "help")
        return { exitCode: 0, stdout: configHelp() + "\n" };
    const suggestion = mergeSuggestion(root, args.explicit);
    if (!args.explicit.lintDirs && args.explicit.codeDirs)
        suggestion.lintDirs = args.explicit.codeDirs;
    const result = args.mode === "apply"
        ? applyConfig(root, suggestion, { preserveExisting: !args.applySuggested && Object.keys(args.explicit).length === 0, dryRun: args.dryRun })
        : checkConfig(root, suggestion);
    return { exitCode: 0, stdout: args.json ? JSON.stringify(result, null, 2) + "\n" : `${result.display.title}\n${result.display.body}\n` };
}
//# sourceMappingURL=config.js.map