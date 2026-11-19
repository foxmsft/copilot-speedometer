import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const READ_LIMIT = 8 * 1024 * 1024;
const HISTORY_TYPES = new Set([
    "session.start", "session.model_change", "session.model_deselected", "user.message",
    "assistant.turn_start", "assistant.turn_end", "assistant.message", "abort", "session.usage_record",
    "session.usage_checkpoint",
]);
export const isSessionId = (id) => typeof id === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id);
export const copilotHome = () => process.env.COPILOT_HOME || join(homedir(), ".copilot");

export async function readJournal(sessionId, home = copilotHome(), usageOnly = false) {
    if (!isSessionId(sessionId)) return null;
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
        let invalid = false;
        for (const line of lines) {
            if (!line.trim()) continue;
            if (usageOnly && !/"type"\s*:\s*"session\.(?:start|usage_record|usage_checkpoint|shutdown)"/u.test(line)) continue;
            let event;
            try {
                event = JSON.parse(line);
            } catch (error) {
                if (!(error instanceof SyntaxError)) throw error;
                invalid = true;
                continue;
            }
            if (usageOnly) {
                if (event?.type === "session.start") {
                    events.push({ type: event.type, checkpoint: event.checkpoint, sessionId: event.data?.sessionId });
                } else if (event?.type === "session.usage_checkpoint" || event?.type === "session.shutdown") {
                    events.push({ type: event.type, watermarks: event.data?.usageAccountingWatermarks });
                } else if (event?.type === "session.usage_record" && !event.checkpoint) {
                    const d = event.data?.usage;
                    events.push({
                        type: event.type, id: event.id, model: d?.model, name: d?.modelDisplayName,
                        provider: d?.provider, input: d?.inputTokens, output: d?.outputTokens,
                        accounting: d?.accounting, apiCallId: d?.apiCallId,
                    });
                }
            } else if (HISTORY_TYPES.has(event?.type)) events.push(event);
        }
        return { events, limited: offset > 0, invalid };
    } finally {
        await file.close();
    }
}
