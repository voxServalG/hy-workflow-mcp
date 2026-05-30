import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class McpHarness {
  private proc: ReturnType<typeof spawn>;
  private resolvers = new Map<number, { resolve: Function; reject: Function }>();
  private nextId = 1;

  constructor(serverPath?: string) {
    const sp = serverPath ?? join(__dirname, "..", "dist", "server.js");
    this.proc = spawn("node", [sp], { cwd: join(__dirname, ".."), stdio: ["pipe", "pipe", "pipe"] });

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        const resolver = this.resolvers.get(msg.id);
        if (resolver) {
          this.resolvers.delete(msg.id);
          if (msg.error) resolver.reject(new Error(msg.error.message));
          else resolver.resolve(msg.result);
        }
      } catch {}
    });
  }

  async init(): Promise<void> {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "harness", version: "1.0" },
    });
  }

  async send(method: string, params?: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.resolvers.set(id, { resolve, reject });
      const req = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n";
      this.proc.stdin!.write(req);
    });
  }

  async call(name: string, args: Record<string, any> = {}): Promise<any> {
    const result = await this.send("tools/call", { name, arguments: args });
    const text = result.content?.[0]?.text;
    if (!text) return result;
    try { return JSON.parse(text); }
    catch { return text; }
  }

  assert(cond: boolean, msg: string): void {
    if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  }

  async close(): Promise<void> {
    this.proc.kill();
  }
}
