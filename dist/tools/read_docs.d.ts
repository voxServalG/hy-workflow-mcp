import { type DocumentReadStage } from "../state.js";
import { type ToolResult } from "./_base.js";
export declare function handleReadDocs(args: {
    stage?: DocumentReadStage;
    task?: string;
}): Promise<ToolResult>;
