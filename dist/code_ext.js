export const JS_TS_CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
export const PYTHON_CODE_EXTS = new Set([".py", ".pyw", ".pyi"]);
export const KNOWN_CODE_EXTS = new Set([
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".java", ".c", ".h", ".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".cs",
    ".go", ".rs", ".swift", ".kt", ".kts", ".scala", ".sc", ".dart", ".m", ".mm",
    ".groovy", ".gradle", ".sol", ".proto", ".thrift", ".glsl", ".vert", ".frag",
    ".geom", ".tesc", ".tese", ".comp", ".wgsl", ".cu", ".cuh", ".cl", ".d", ".vala",
    ".v", ".vh", ".sv", ".svh", ".metal", ".processing", ".pde", ".ino", ".zig",
    ".css", ".pcss", ".postcss", ".scss", ".sass", ".less",
    ".html", ".htm", ".xhtml", ".xml", ".svg", ".vue", ".svelte", ".rss", ".atom",
    ".plist", ".xaml", ".csproj", ".vbproj", ".fsproj", ".props", ".targets",
    ".py", ".pyw", ".pyi", ".bzl", ".bazel", ".star", ".scons", ".rpy",
    ".sh", ".bash", ".zsh", ".fish", ".ksh", ".csh", ".tcsh", ".rb", ".rake",
    ".gemspec", ".pl", ".pm", ".t", ".r", ".nim", ".cr", ".ex", ".exs", ".coffee",
    ".feature", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".mk", ".mak",
    ".dockerfile", ".cmake", ".ps1", ".psm1", ".psd1", ".jl", ".php", ".sql",
    ".psql", ".mysql", ".pgsql", ".lua", ".hs", ".lhs", ".erl", ".hrl", ".clj",
    ".cljs", ".cljc", ".edn", ".lisp", ".lsp", ".el", ".scm", ".ss", ".rkt",
    ".tf", ".tfvars", ".hcl", ".nix", ".bat", ".cmd", ".fs", ".fsi", ".fsx",
    ".ml", ".mli", ".elm", ".ada", ".adb", ".ads", ".f", ".for", ".f90",
    ".f95", ".f03", ".f08", ".tex", ".sty", ".cls", ".vb", ".vbs", ".vim",
    ".vimrc", ".dockerignore", ".gitignore", ".npmrc", ".env", ".md", ".markdown",
    ".tksp",
]);
export function normalizeCodeExt(value) {
    const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    return [...new Set(raw
            .flatMap(item => typeof item === "string" ? item.split(",") : [])
            .map(item => item.trim())
            .filter(Boolean)
            .map(item => item.startsWith(".") ? item : `.${item}`))];
}
export function codeExtOr(value, fallback) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value) && value.every(item => typeof item === "string"))
        return value;
    return fallback;
}
export function formatCodeExt(value) {
    return normalizeCodeExt(value).join(",");
}
export function validateCodeExt(value) {
    const exts = normalizeCodeExt(value);
    if (!exts.length)
        return ["project.codeExt must include at least one extension"];
    return exts
        .filter(ext => !/^\.[A-Za-z0-9][A-Za-z0-9+_-]*$/.test(ext))
        .map(ext => `project.codeExt entry is invalid: ${ext}`);
}
export function isKnownCodeExt(ext) {
    return KNOWN_CODE_EXTS.has(ext);
}
//# sourceMappingURL=code_ext.js.map