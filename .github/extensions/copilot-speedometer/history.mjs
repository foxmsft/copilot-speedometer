import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const READ_LIMIT = 8 * 1024 * 1024;
const HISTORY_TYPES = new Set([
    "session.start", "session.model_change", "session.model_deselected", "user.message",
    "assistant.turn_start", "assistant.turn_end", "assistant.message", "abort", "session.usage_record",
]);

export async function readJournal(sessionId, home = process.env.COPILOT_HOME || join(homedir(), ".copilot")) {
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(sessionId ?? "")) return null;
    let file;
    try {
        file = await open(join(home, "session-state", sessionId, "events.jsonl"), "r");
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
    try {
        const { size } = await file.stat();
        const offset = Math.max(0, size - READ_LIMIT);
        const buffer = Buffer.alloc(size - offset);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        const text = buffer.toString("utf8", 0, bytesRead);
        const lines = text.split("\n");
        if (offset > 0) lines.shift();
        // The last physical record may still be in the middle of being appended.
        lines.pop();
        const events = [];
        for (const line of lines) {
            if (!line.trim()) continue;
            let event;
            try {
                event = JSON.parse(line);
            } catch (error) {
                if (error instanceof SyntaxError) continue;
                throw error;
            }
            if (HISTORY_TYPES.has(event?.type)) events.push(event);
        }
        return { events, limited: offset > 0 };
    } finally {
        await file.close();
    }
}
