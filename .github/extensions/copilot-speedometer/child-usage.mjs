import { stat } from "node:fs/promises";
import { join } from "node:path";
import { copilotHome, isSessionId, readJournal } from "./history.mjs";
import { mergeUsageRows, withTotals } from "./session-usage.mjs";

const SESSION_LIMIT = 128;
const validCount = (n) => Number.isSafeInteger(n) && n >= 0;

export async function findDescendants(sessionId, home = copilotHome()) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(home, "data.db"), { readOnly: true, timeout: 50 });
    try {
        // The sidebar stores chat links separately from project/workspace links.
        // A project created by a chat uses creator_session_id without a workspace link.
        const lookup = db.prepare(`
            SELECT s.id, w.id AS workspace FROM sessions s
            LEFT JOIN workspace_session_aliases a ON a.session_id = s.id
            LEFT JOIN workspaces w ON w.id = a.workspace_id OR w.session_id = s.id
            WHERE s.id = ?
        `);
        const children = db.prepare(`
            SELECT l.session_id AS id, NULL AS workspace,
                s.execution_location = 'local' AND s.remote_connect_target IS NULL AND NOT coalesce(s.is_cloud_worker, 0) AS local
            FROM chat_parent_links l LEFT JOIN sessions s ON s.id = l.session_id
            WHERE l.parent_session_id IN (?, ?)
            UNION
            SELECT w.session_id AS id, w.id AS workspace,
                w.host_id = 'local' AND s.execution_location = 'local'
                AND s.remote_connect_target IS NULL AND NOT coalesce(s.is_cloud_worker, 0) AS local
            FROM workspaces w
            LEFT JOIN workspace_parent_links l ON l.child_workspace_id = w.id
            LEFT JOIN sessions s ON s.id = w.session_id
            WHERE l.parent_workspace_id = ? OR
                (l.parent_workspace_id IS NULL AND coalesce(l.creator_session_id, w.creator_session_id) IN (?, ?))
            LIMIT ?
        `);
            const root = lookup.get(sessionId);
        if (!root) return null;
        const result = [];
        const visited = new Set([root.workspace || root.id]);
        const queue = [root];
        let limited = false;
        for (const { id, workspace } of queue) {
            for (const child of children.all(id, workspace, workspace, id, workspace, SESSION_LIMIT + 1)) {
                const key = child.workspace || child.id;
                if (!key || visited.has(key)) continue;
                if (result.length >= SESSION_LIMIT) {
                    limited = true;
                    break;
                }
                visited.add(key);
                result.push({ id: child.id, local: child.local === 1 && isSessionId(child.id) });
                queue.push(child);
            }
            if (limited) break;
        }
        return { descendants: result, limited };
    } finally {
        db.close();
    }
}

function receipt(event) {
    const { sourceSessionId: source, sequence, usageId } = event.accounting ?? {};
    const seq = isSessionId(source) && validCount(sequence) && sequence > 0 ? sequence : null;
    const call = usageId || event.apiCallId;
    return {
        source, sequence: seq, key: seq == null ? null : `${source}:${seq}`,
        ids: [call, event.apiCallId].filter((id) => typeof id === "string" && id.length),
        row: {
            model: event.model || null, name: event.name || event.model || "Unattributed model",
            providerId: event.provider?.id ?? null, provider: event.provider?.label || event.provider?.id || null,
            input: validCount(event.input) ? event.input : null,
            output: validCount(event.output) ? event.output : null, calls: 1,
        },
    };
}

function readLedger(journal, sessionId) {
    if (!journal) return null;
    const calls = new Map();
    const ids = new Set();
    const watermarks = new Map();
    let started = false;
    let incomplete = journal.limited || journal.invalid;
    for (const event of journal.events) {
        if (event.type === "session.start") {
            if (!event.checkpoint) {
                if (event.sessionId !== sessionId) return null;
                started = true;
            }
            continue;
        }
        if (event.type !== "session.usage_record") {
            for (const [source, sequence] of Object.entries(event.watermarks ?? {})) {
                if (isSessionId(source) && validCount(sequence)) {
                    watermarks.set(source, Math.max(watermarks.get(source) ?? 0, sequence));
                }
            }
            continue;
        }
        const call = receipt(event);
        const duplicate = (call.key && calls.has(call.key)) || call.ids.some((id) => ids.has(id));
        if (!duplicate) {
            const key = call.key || call.ids[0] || event.id;
            if (key) calls.set(key, call);
            else incomplete = true;
        }
        for (const id of call.ids) ids.add(id);
    }
    return { calls, ids, watermarks, incomplete: incomplete || !started };
}

export function rollupUsage(parent, hierarchy, parentJournal, journals, sessionId) {
    const status = (state, known = null, included = 0, missing = null) =>
        ({ status: state, known, included, missing, usage: parent });
    if (!hierarchy) return status("unavailable");
    const { descendants, limited } = hierarchy;
    if (!descendants.length) return status("complete", 0, 0, 0);

    const parentLedger = readLedger(parentJournal, sessionId);
    const ledgerTotals = withTotals([...(parentLedger?.calls.values() ?? [])].map((c) => c.row), "recorded");
    // Reconcile aggregate SDK counters against the parent receipts before adding
    // another session. Otherwise an imported call without a visible receipt could be counted twice.
    if (!parentLedger || parent.total == null || parentLedger.incomplete ||
        [...parentLedger.calls.values()].some((call) => !call.key && !call.ids.length) ||
        !["input", "output", "calls"].every((field) => parent[field] === ledgerTotals[field])) {
        return status("partial", descendants.length, 0, descendants.length);
    }
    const keys = new Set(parentLedger.calls.keys());
    const ids = new Set(parentLedger.ids);
    const rows = [...parent.models];
    let included = 0;
    let missing = 0;
    for (const { id, local } of descendants) {
        const ledger = local && readLedger(journals.get(id), id);
        if (!ledger) {
            missing++;
            continue;
        }
        const ownCalls = [...ledger.calls.values()].filter((call) => call.source === id && call.key);
        const highest = ownCalls.reduce((n, call) => Math.max(n, call.sequence), ledger.watermarks.get(id) ?? 0);
        let incomplete = ledger.incomplete || ownCalls.length !== highest ||
            [...ledger.calls.values()].some((call) => !call.key);
        let contributed = false;
        for (const call of ownCalls) {
            if (keys.has(call.key) || call.sequence <= (parentLedger.watermarks.get(id) ?? 0)
                || call.ids.some((id) => ids.has(id))) continue;
            if (call.row.input == null || call.row.output == null) {
                incomplete = true;
                continue;
            }
            rows.push(call.row);
            keys.add(call.key);
            for (const id of call.ids) ids.add(id);
            contributed = true;
        }
        if (!incomplete || contributed) included++;
        if (incomplete) missing++;
    }
    return {
        ...status(missing || limited ? "partial" : "complete", descendants.length, included, missing),
        usage: withTotals(mergeUsageRows(rows), parent.source, {
            userRequests: parent.userRequests, apiDurationMs: parent.apiDurationMs,
        }),
    };
}

export function createChildUsageReader(sessionId, home = copilotHome()) {
    const cache = new Map();
    async function read(id) {
        try {
            const { size, mtimeMs, ino } = await stat(join(home, "session-state", id, "events.jsonl"));
            const stamp = `${size}:${mtimeMs}:${ino}`;
            if (cache.get(id)?.stamp === stamp) return cache.get(id).journal;
            const journal = await readJournal(id, home, true);
            cache.set(id, { stamp, journal });
            return journal;
        } catch (error) {
            if (!["ENOENT", "EACCES", "EPERM", "EBUSY"].includes(error.code)) throw error;
            cache.delete(id);
            return null;
        }
    }
    return async (parent) => {
        if (!isSessionId(sessionId)) return rollupUsage(parent, null);
        const hierarchy = await findDescendants(sessionId, home);
        if (!hierarchy?.descendants.length) return rollupUsage(parent, hierarchy);
        const parentJournal = await read(sessionId);
        const journals = new Map();
        const active = new Set([sessionId]);
        for (const child of hierarchy.descendants) {
            if (!child.local || journals.has(child.id)) continue;
            active.add(child.id);
            journals.set(child.id, await read(child.id));
        }
        for (const id of cache.keys()) if (!active.has(id)) cache.delete(id);
        return rollupUsage(parent, hierarchy, parentJournal, journals, sessionId);
    };
}
