import OpenAI from "openai";
const API_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const PLAN_SCHEMA = `
{
  "type": "object",
  "properties": {
    "task": { "type": "string", "description": "Brief task summary" },
    "scope": {
      "type": "object",
      "properties": {
        "changes":   { "type": "array", "items": { "type": "string" }, "description": "Existing files to modify" },
        "new_files": { "type": "array", "items": { "type": "string" }, "description": "New files to create" },
        "delete":    { "type": "array", "items": { "type": "string" }, "description": "Files to delete" }
      },
      "required": ["changes", "new_files", "delete"],
      "additionalProperties": false
    },
    "boundary": {
      "type": "object",
      "properties": {
        "dependency_dag": { "type": "string", "description": "Text description of dependency impact" },
        "entry_points":   { "type": "array", "items": { "type": "string" }, "description": "Executable shell commands (min 1)" },
        "no_new_external": { "type": "boolean", "description": "Whether this introduces new external deps" }
      },
      "required": ["dependency_dag", "entry_points", "no_new_external"],
      "additionalProperties": false
    },
    "verify": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "object",
          "properties": {
            "python_version": { "type": "string", "description": "Minimum Python version" },
            "setup": { "type": "array", "items": { "type": "string" }, "description": "Environment setup commands" }
          },
          "required": ["python_version", "setup"],
          "additionalProperties": false
        },
        "smoke": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "command":      { "type": "string", "description": "Shell command to run" },
              "expected_exit": { "type": "number", "description": "Expected exit code (0 for success)" },
              "description":  { "type": "string", "description": "What this check verifies" }
            },
            "required": ["command", "expected_exit", "description"],
            "additionalProperties": false
          },
          "description": "Quick smoke tests (<5s each, min 1)"
        },
        "tests": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "command":      { "type": "string" },
              "expected_exit": { "type": "number" },
              "description":  { "type": "string" }
            },
            "required": ["command", "expected_exit", "description"],
            "additionalProperties": false
          },
          "description": "Full test suite (min 1)"
        }
      },
      "required": ["platform", "smoke", "tests"],
      "additionalProperties": false
    },
    "risks":      { "type": "array", "items": { "type": "string" }, "description": "Honest risk list (min 1)" },
    "discussion": { "type": "string", "description": "Why this approach was chosen over alternatives" }
  },
  "required": ["task", "scope", "boundary", "verify", "risks", "discussion"],
  "additionalProperties": false
}
`;
export async function generatePlanDoc(task, context) {
    if (!API_KEY) {
        return { ok: false, error: "DEEPSEEK_API_KEY not set. Set it in your environment or ask the user to provide it." };
    }
    const client = new OpenAI({ apiKey: API_KEY, baseURL: "https://api.deepseek.com" });
    const system = `You are a project planning assistant. Given a task description and project context, generate a PlanDoc in JSON format following the exact schema below.

Rules:
- scope.changes must be real file paths (e.g. "src/server.ts"), not descriptions like "modify config"
- boundary.entry_points must be executable shell commands (e.g. "npx tsc --noEmit"), not "check compilation"
- smoke and tests commands must be real shell commands, never "echo ok"
- risks must be honest, not "No risks"
- Analyze the project context to identify the correct files and entry points

Project context:
${context}

TASK:
${task}

Output the PlanDoc as valid JSON only. Do not wrap in markdown.`;
    const maxAttempts = 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
            await new Promise(r => setTimeout(r, 2000));
        }
        try {
            const response = await client.chat.completions.create({
                model: "deepseek-v4-pro",
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: system + "\n\nOutput must conform to this JSON Schema:\n" + PLAN_SCHEMA },
                    { role: "user", content: task },
                ],
            });
            const raw = response.choices[0]?.message?.content ?? "";
            try {
                const plan = JSON.parse(raw);
                return { ok: true, plan };
            }
            catch {
                return { ok: false, error: "Failed to parse PlanDoc JSON from API response: " + raw.slice(0, 200) };
            }
        }
        catch (e) {
            if (attempt === maxAttempts - 1) {
                return { ok: false, error: `DeepSeek API error after ${maxAttempts} attempts: ${e.message || String(e)}` };
            }
        }
    }
    return { ok: false, error: "Unexpected retry loop exit" };
}
//# sourceMappingURL=llm.js.map