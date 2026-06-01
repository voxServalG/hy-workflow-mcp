import type { ToolResult } from "./_base.js";
interface Section {
    heading: string;
    content: string;
}
export declare function handleCommit(args: {
    title: string;
    sections?: Section[];
    body?: string;
}): Promise<ToolResult>;
export {};
