import * as fs from "node:fs";
import * as path from "node:path";
export const UNIFIED_CONFIG_FILE = "hy-workflow.json";
const COMPAT_CONFIG_FILES = ["codelint.json", "doclint.json", "docs-gardener.json"];
const CONFIG_FILES = [UNIFIED_CONFIG_FILE, ...COMPAT_CONFIG_FILES];
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
function inferLintDirs(root, codeDirs) {
    if (exists(root, "src"))
        return ["src"];
    return codeDirs;
}
export function defaultSuggestion(root) {
    const detected = detectProject(root);
    const codeExt = detected.kind === "python" ? ".py" : ".ts";
    const codeDirs = inferDirs(root, codeExt);
    return {
        codeExt,
        codeDirs,
        lintDirs: inferLintDirs(root, codeDirs),
        docsDir: exists(root, "docs") ? "docs" : "docs",
        baseBranch: "dev",
        maxCodeLines: 500,
        maxDocLines: 200,
    };
}
function mergeSuggestion(root, explicit) {
    return { ...defaultSuggestion(root), ...explicit };
}
function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function arrayOr(value, fallback) {
    return Array.isArray(value) && value.every(item => typeof item === "string") ? value : fallback;
}
function stringOr(value, fallback) {
    return typeof value === "string" ? value : fallback;
}
function numberOr(value, fallback) {
    return typeof value === "number" ? value : fallback;
}
function unifiedFromInputs(existing, legacy, suggestion, preserveExisting) {
    const project = asObject(existing?.project);
    const codelint = asObject(existing?.codelint);
    const doclint = asObject(existing?.doclint);
    const docsGardener = asObject(existing?.docsGardener);
    const legacyCode = legacy["codelint.json"];
    const legacyDocs = legacy["doclint.json"];
    const legacyGardener = legacy["docs-gardener.json"];
    const use = (current, legacyValue, suggested) => preserveExisting ? current ?? legacyValue ?? suggested : suggested ?? current ?? legacyValue;
    return {
        ...(existing ?? {}),
        project: {
            ...project,
            baseBranch: use(project.baseBranch, legacyCode?.baseBranch ?? legacyDocs?.baseBranch ?? legacyGardener?.baseBranch, suggestion.baseBranch),
            codeExt: use(project.codeExt, legacyCode?.codeExt ?? legacyDocs?.codeExt ?? legacyGardener?.codeExt, suggestion.codeExt),
            codeDirs: use(project.codeDirs, legacyDocs?.codeDirs ?? legacyGardener?.codeDirs ?? legacyCode?.codeDirs, suggestion.codeDirs),
            docsDir: use(project.docsDir, legacyDocs?.docsDir ?? legacyGardener?.docsDir, suggestion.docsDir),
        },
        codelint: {
            ...codelint,
            lintDirs: use(codelint.lintDirs, legacyCode?.lintDirs, suggestion.lintDirs),
            maxLines: use(codelint.maxLines, legacyCode?.maxLines, suggestion.maxCodeLines),
        },
        doclint: {
            ...doclint,
            maxLines: use(doclint.maxLines, legacyDocs?.maxLines, suggestion.maxDocLines),
        },
        docsGardener: {
            ...docsGardener,
            catalogs: preserveExisting
                ? docsGardener.catalogs ?? legacyGardener?.catalogs ?? {}
                : docsGardener.catalogs ?? legacyGardener?.catalogs ?? {},
        },
    };
}
function normalizedUnified(config, suggestion) {
    const project = asObject(config.project);
    const codelint = asObject(config.codelint);
    const doclint = asObject(config.doclint);
    const docsGardener = asObject(config.docsGardener);
    return {
        ...config,
        project: {
            ...project,
            baseBranch: stringOr(project.baseBranch, suggestion.baseBranch),
            codeExt: stringOr(project.codeExt, suggestion.codeExt),
            codeDirs: arrayOr(project.codeDirs, suggestion.codeDirs),
            docsDir: stringOr(project.docsDir, suggestion.docsDir),
        },
        codelint: {
            ...codelint,
            lintDirs: arrayOr(codelint.lintDirs, suggestion.lintDirs),
            maxLines: numberOr(codelint.maxLines, suggestion.maxCodeLines),
        },
        doclint: {
            ...doclint,
            maxLines: numberOr(doclint.maxLines, suggestion.maxDocLines),
        },
        docsGardener: {
            ...docsGardener,
            catalogs: docsGardener.catalogs ?? {},
        },
    };
}
function compatConfigs(existing, unified) {
    const project = asObject(unified.project);
    const codelint = asObject(unified.codelint);
    const doclint = asObject(unified.doclint);
    const docsGardener = asObject(unified.docsGardener);
    return {
        "codelint.json": {
            ...(existing["codelint.json"] ?? {}),
            lintDirs: codelint.lintDirs,
            codeDirs: project.codeDirs,
            codeExt: project.codeExt,
            baseBranch: project.baseBranch,
            maxLines: codelint.maxLines,
        },
        "doclint.json": {
            ...(existing["doclint.json"] ?? {}),
            docsDir: project.docsDir,
            codeDirs: project.codeDirs,
            codeExt: project.codeExt,
            baseBranch: project.baseBranch,
            maxLines: doclint.maxLines,
        },
        "docs-gardener.json": {
            ...(existing["docs-gardener.json"] ?? {}),
            docsDir: project.docsDir,
            codeDirs: project.codeDirs,
            codeExt: project.codeExt,
            baseBranch: project.baseBranch,
            catalogs: docsGardener.catalogs ?? {},
        },
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
        [UNIFIED_CONFIG_FILE]: readJson(root, UNIFIED_CONFIG_FILE),
        "codelint.json": readJson(root, "codelint.json"),
        "doclint.json": readJson(root, "doclint.json"),
        "docs-gardener.json": readJson(root, "docs-gardener.json"),
    };
    const unified = normalizedUnified(unifiedFromInputs(before[UNIFIED_CONFIG_FILE], before, suggestion, options.preserveExisting), suggestion);
    const after = {
        [UNIFIED_CONFIG_FILE]: unified,
        ...compatConfigs(before, unified),
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
        issues: options.dryRun ? result.issues : [],
        drift: options.dryRun ? result.drift : [],
        changed,
        preserved,
        dryRun: options.dryRun,
        display: {
            title: options.dryRun ? "Config dry run complete" : "Config updated",
            body: `${options.dryRun ? "Would update" : "Updated"} ${changed.length ? changed.join(", ") : "no config files"} while preserving unknown fields and deriving compatibility artifacts from ${UNIFIED_CONFIG_FILE}.`,
        },
        hint: "Rerun hy_init after applying config changes so setup artifacts and workflow state can be validated.",
    };
}
function valueArray(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}
function addDrift(drift, file, field, expected, actual) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        drift.push({ file, field, expected, actual });
    }
}
function compareCompat(file, actual, expected, fields) {
    const drift = [];
    if (!actual)
        return drift;
    for (const field of fields)
        addDrift(drift, file, field, expected[field], actual[field]);
    return drift;
}
export function checkConfig(root, suggestion = defaultSuggestion(root)) {
    const project = detectProject(root);
    const issues = [];
    const drift = [];
    const unifiedRaw = readJson(root, UNIFIED_CONFIG_FILE);
    const codelint = readJson(root, "codelint.json");
    const doclint = readJson(root, "doclint.json");
    const gardener = readJson(root, "docs-gardener.json");
    if (!unifiedRaw)
        issues.push(`Missing ${UNIFIED_CONFIG_FILE}`);
    if (!codelint)
        issues.push("Missing codelint.json");
    if (!doclint)
        issues.push("Missing doclint.json");
    if (!gardener)
        issues.push("Missing docs-gardener.json");
    const unified = normalizedUnified(unifiedRaw ?? unifiedFromInputs(null, { "codelint.json": codelint, "doclint.json": doclint, "docs-gardener.json": gardener }, suggestion, true), suggestion);
    const projectConfig = asObject(unified.project);
    const expectedCompat = compatConfigs({ "codelint.json": codelint, "doclint.json": doclint, "docs-gardener.json": gardener }, unified);
    const expectedExt = project.kind === "python" ? ".py" : project.kind === "typescript" ? ".ts" : null;
    if (expectedExt && projectConfig.codeExt && projectConfig.codeExt !== expectedExt)
        issues.push(`${UNIFIED_CONFIG_FILE} project.codeExt=${projectConfig.codeExt} but project appears ${project.kind}`);
    if (projectConfig.docsDir && !exists(root, projectConfig.docsDir))
        issues.push(`${UNIFIED_CONFIG_FILE} project.docsDir does not exist: ${projectConfig.docsDir}`);
    for (const dir of valueArray(projectConfig.codeDirs)) {
        if (!exists(root, dir))
            issues.push(`${UNIFIED_CONFIG_FILE} project.codeDirs entry does not exist: ${dir}`);
    }
    for (const dir of valueArray(asObject(unified.codelint).lintDirs)) {
        if (!exists(root, dir))
            issues.push(`${UNIFIED_CONFIG_FILE} codelint.lintDirs entry does not exist: ${dir}`);
    }
    drift.push(...compareCompat("codelint.json", codelint, expectedCompat["codelint.json"], ["lintDirs", "codeDirs", "codeExt", "baseBranch", "maxLines"]));
    drift.push(...compareCompat("doclint.json", doclint, expectedCompat["doclint.json"], ["docsDir", "codeDirs", "codeExt", "baseBranch", "maxLines"]));
    drift.push(...compareCompat("docs-gardener.json", gardener, expectedCompat["docs-gardener.json"], ["docsDir", "codeDirs", "codeExt", "baseBranch", "catalogs"]));
    for (const item of drift)
        issues.push(`${item.file} drift at ${item.field}`);
    const ambiguous = project.kind === "mixed" || project.kind === "unknown";
    const suggestedCommand = buildSuggestedCommand(suggestion, ambiguous);
    const ok = issues.length === 0 && !ambiguous;
    const driftBody = drift.length
        ? ["", "Config drift:", ...drift.map(item => `- ${item.file}.${item.field}: expected ${JSON.stringify(item.expected)}, actual ${JSON.stringify(item.actual)}`)].join("\n")
        : "";
    return {
        ok,
        phase: "config",
        next: "config",
        display: {
            title: ok ? "Config looks consistent" : "Project config needs confirmation",
            body: ok
                ? `${UNIFIED_CONFIG_FILE} is the source of truth and compatibility JSON artifacts are in sync.`
                : `${issues.length ? issues.join("\n") : `Project type is ${project.kind}; explicit confirmation is required.`}${driftBody}\n\nSuggested command:\n${suggestedCommand}`,
        },
        hint: ok ? "Continue with hy_init or the requested workflow task." : "Show display.body and run the suggested config command only after user approval.",
        requires_user: ok ? false : true,
        stop_here: ok ? false : true,
        allowedTools: ok ? ["hy_init", "hy_status"] : ["terminal", "hy_init", "hy_status"],
        recovery: ok ? undefined : { tool: "terminal", instruction: suggestedCommand },
        project,
        issues,
        drift,
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
        `${UNIFIED_CONFIG_FILE} is the source of truth. codelint.json, doclint.json, and docs-gardener.json are generated compatibility artifacts.`,
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