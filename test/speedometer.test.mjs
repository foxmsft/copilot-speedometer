import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { readJournal } from "../.github/extensions/copilot-speedometer/history.mjs";
import { Speedometer } from "../.github/extensions/copilot-speedometer/metrics.mjs";
import { startServer } from "../.github/extensions/copilot-speedometer/server.mjs";
import { SessionUsage } from "../.github/extensions/copilot-speedometer/session-usage.mjs";
import { findDescendants, rollupUsage } from "../.github/extensions/copilot-speedometer/child-usage.mjs";

const sessionId = "11111111-2222-4333-8444-555555555555";
const time = Date.UTC(2026, 10, 19);
const event = (type, ms, data, extra) => ({
    type, timestamp: new Date(time + ms).toISOString(), data, id: `${type}:${ms}`, ...extra,
});
const ingest = (meter, type, ms, data, extra) => meter.ingest(event(type, ms, data, extra), "sdk", time + ms);
const startQuery = (meter, n = 1, ms = 0) => {
    const data = { turnId: "0", interactionId: `q${n}` };
    ingest(meter, "user.message", ms, { ...data, content: "private prompt" });
    ingest(meter, "assistant.turn_start", ms + 10, data);
    return data;
};

const modelUsage = (modelId, providerId, inputTokens, outputTokens, calls = 1) => ({
    modelId, provider: { id: providerId, label: providerId },
    metrics: {
        requests: { count: calls },
        usage: { inputTokens, outputTokens, cacheReadTokens: 30, cacheWriteTokens: 10, reasoningTokens: 5 },
    },
});

test("follows actual sidebar link types across chats and workspaces, excluding unrelated work", async (t) => {
    const { DatabaseSync } = await import("node:sqlite");
    const home = await mkdtemp(join(tmpdir(), "speedometer-hierarchy-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const db = new DatabaseSync(join(home, "data.db"));
    const root = sessionId;
    const child = "11111111-2222-4333-8444-555555555556";
    const grandchild = "11111111-2222-4333-8444-555555555557";
    const remote = "11111111-2222-4333-8444-555555555558";
    db.exec(`
        CREATE TABLE sessions (id TEXT, execution_location TEXT, remote_connect_target TEXT, is_cloud_worker INTEGER);
        CREATE TABLE workspaces (id TEXT, session_id TEXT, host_id TEXT, creator_session_id TEXT);
        CREATE TABLE workspace_session_aliases (session_id TEXT, workspace_id TEXT);
        CREATE TABLE workspace_parent_links (child_workspace_id TEXT, parent_workspace_id TEXT, creator_session_id TEXT);
        CREATE TABLE chat_parent_links (session_id TEXT, parent_session_id TEXT);
        INSERT INTO sessions VALUES
            ('${root}', 'local', NULL, 0), ('${child}', 'local', NULL, 0),
            ('${grandchild}', 'local', NULL, 0), ('${remote}', 'cloud', NULL, 1);
        INSERT INTO workspaces VALUES ('root-workspace', '${root}', 'local', NULL),
            ('child-workspace', '${child}', 'local', NULL), ('unrelated-workspace', 'unrelated', 'local', NULL);
        INSERT INTO workspace_session_aliases VALUES ('${root}', 'root-workspace');
        INSERT INTO workspace_parent_links VALUES ('child-workspace', 'root-workspace', NULL);
        INSERT INTO chat_parent_links VALUES ('${grandchild}', '${child}'), ('${remote}', '${root}');
    `);
    db.close();
    const { descendants, limited } = await findDescendants(root, home);
    assert.equal(limited, false);
    assert.deepEqual(new Map(descendants.map(({ id, local }) => [id, local])),
        new Map([[child, true], [grandchild, true], [remote, false]]));
});

test("checkbox defaults to including children and immediately switches to parent-only usage", async () => {
    const root = new URL("../.github/extensions/copilot-speedometer/", import.meta.url);
    const [page, script] = await Promise.all(["index.html", "speedometer.js"].map((file) => readFile(new URL(file, root), "utf8")));
    assert.match(page, /<label[^>]*><input id="include-children" type="checkbox" checked[^>]*> Include child sessions<\/label>/);
    let change;
    let connection;
    const makeNode = () => ({
        textContent: "", checked: true, setAttribute() {}, append() {}, replaceChildren() {},
        insertCell: () => ({}), addEventListener(type, cb) { if (type === "change") change = cb; },
    });
    const nodes = new Map();
    const get = (id) => {
        if (!nodes.has(id)) nodes.set(id, makeNode());
        return nodes.get(id);
    };
    runInNewContext(script, {
        document: { getElementById: get, createElement: makeNode },
        EventSource: class { constructor() { connection = this; } },
    });
    const meter = new Speedometer(sessionId).snapshot();
    const parent = { source: "sdk", models: [], total: 15 };
    connection.onmessage({ data: JSON.stringify({
        ...meter, sessionUsage: parent,
        childUsage: { status: "complete", known: 1, included: 1, usage: { ...parent, total: 45 } },
    }) });
    assert.equal(get("session-total").textContent, "45");
    get("include-children").checked = false;
    change();
    assert.equal(get("session-total").textContent, "15");
    assert.equal(get("child-coverage").textContent, "Current session only.");
    get("include-children").checked = true;
    change();
    assert.equal(get("session-total").textContent, "45");
});

test("rolls up only uncounted child receipts, marks remote or incomplete children, and preserves parent metrics", () => {
    const child = "11111111-2222-4333-8444-555555555556";
    const remote = "11111111-2222-4333-8444-555555555557";
    const receipt = (id, sequence, input, output) => ({
        type: "session.usage_record", accounting: { sourceSessionId: id, sequence, usageId: `${id}:${sequence}` },
        model: "model", provider: { id: "copilot", label: "copilot" }, input, output,
        cacheReadTokens: 30, reasoningTokens: 1,
    });
    const journal = (sessionId, ...events) => ({ events: [{ type: "session.start", sessionId }, ...events] });
    const imported = receipt(child, 1, 25, 5);
    const parentEvents = journal(sessionId, receipt(sessionId, 1, 75, 15), imported);
    const usage = new SessionUsage();
    usage.setMetrics({
        modelMetrics: {}, providerModelMetrics: [modelUsage("model", "copilot", 100, 20, 2)],
        totalUserRequests: 1, totalApiDurationMs: 2000,
    });
    const parent = usage.snapshot();
    const descendants = [{ id: child, local: true }, { id: remote, local: false }];
    const journals = new Map([[child, journal(child, imported, receipt(child, 2, 50, 10), receipt(child, 2, 50, 10))]]);
    const result = rollupUsage(parent, { descendants }, parentEvents, journals, sessionId);
    assert.deepEqual([result.status, result.included, result.missing], ["partial", 1, 1]);
    assert.deepEqual(
        [result.usage.input, result.usage.output, result.usage.total, result.usage.calls, result.usage.userRequests, result.usage.apiDurationMs],
        [150, 30, 180, 3, 1, 2000],
    );
    assert.equal(parent.total, 120);
    assert.equal(result.usage.models.length, 1);
    const unreconciled = rollupUsage(parent, { descendants }, journal(sessionId, imported), journals, sessionId);
    assert.deepEqual([unreconciled.status, unreconciled.included, unreconciled.usage.total], ["partial", 0, 120]);
    journals.set(child, journal(child, imported, receipt(child, 3, 50, 10)));
    const withGap = rollupUsage(parent, { descendants: [descendants[0]] }, parentEvents, journals, sessionId);
    assert.deepEqual([withGap.status, withGap.missing, withGap.usage.total], ["partial", 1, 180]);
});

test("SDK session totals count input and output once and keep provider/model attribution", () => {
    const usage = new SessionUsage();
    const providerModelMetrics = [modelUsage("model", "copilot", 80, 20, 2), modelUsage("model", "local", 40, 10)];
    usage.setMetrics({
        providerModelMetrics,
        modelMetrics: { model: modelUsage("model", null, 120, 30, 3).metrics },
        totalUserRequests: 2, totalApiDurationMs: 1800,
    });
    const state = usage.snapshot();
    assert.equal(state.source, "sdk");
    assert.deepEqual(state.models.map(({ model, provider, input, output, total }) => [model, provider, input, output, total]), [
        ["model", "copilot", 80, 20, 100],
        ["model", "local", 40, 10, 50],
    ]);
    assert.deepEqual([state.input, state.output, state.total, state.calls, state.userRequests, state.apiDurationMs], [120, 30, 150, 3, 2, 1800]);
    usage.setMetrics({ modelMetrics: { model: modelUsage("model", null, 150, 35, 4).metrics } });
    assert.equal(usage.snapshot().total, 185);
    assert.equal(usage.snapshot().models[0].provider, null);
});

test("recorded usage restores a checkpoint and deduplicates replayed receipts and SDK events", () => {
    const usage = new SessionUsage();
    const call = (sequence, data = {}) => ({
        model: "model", provider: { id: "copilot" }, inputTokens: 25, outputTokens: 5,
        cacheReadTokens: 10, reasoningTokens: 2, apiCallId: `call-${sequence}`,
        accounting: { sourceSessionId: sessionId, sequence }, ...data,
    });
    usage.ingest(event("session.usage_record", 10, { usage: call(1) }));
    usage.ingest(event("session.usage_checkpoint", 11, {
        providerModelMetrics: [modelUsage("model", "copilot", 100, 20, 5)],
        usageAccountingWatermarks: { [sessionId]: 5 },
    }, { checkpoint: true }));
    usage.ingest(event("assistant.usage", 12, call(3)));
    usage.ingest(event("assistant.usage", 13, call(6, { accounting: undefined })));
    usage.ingest(event("session.usage_record", 14, { usage: call(6) }));
    usage.ingest(event("assistant.usage", 15, call(6)));
    usage.ingest(event("assistant.usage", 16, call(7, { model: "subagent-model", interactionType: "conversation-subagent" }), { agentId: "subagent" }));
    usage.useFallback();
    const state = usage.snapshot();
    assert.equal(state.source, "recorded");
    assert.deepEqual(state.models.map(({ model, total }) => [model, total]), [["model", 150], ["subagent-model", 30]]);
    assert.deepEqual([state.input, state.output, state.total, state.calls], [150, 30, 180, 7]);
    assert.equal(state.userRequests, null);
});

test("rolls only visible root deltas, preserves chart gaps, and resets on the next query", () => {
    const meter = new Speedometer(sessionId);
    const d = startQuery(meter);
    ingest(meter, "assistant.reasoning_delta", 100, { deltaContent: "private reasoning" });
    ingest(meter, "assistant.message_delta", 200, { messageId: "child", deltaContent: "abcd" }, { agentId: "sub" });
    ingest(meter, "assistant.message_delta", 250, { messageId: "m", deltaContent: " " });
    assert.equal(meter.snapshot(time + 250).stream.rate, null);
    ingest(meter, "assistant.message_delta", 500, { messageId: "m", deltaContent: "abcdabcd" });
    ingest(meter, "assistant.message_delta", 750, { messageId: "m", deltaContent: "abcdabcd" });
    const live = meter.snapshot(time + 750);
    assert.equal(live.stream.rate, 8);
    assert.equal(live.query.firstVisibleMs, 500);
    assert.equal(live.query.firstVisibleSource, "delta");
    assert.equal(live.query.deltaCount, 2);
    assert.equal(meter.snapshot(time + 3_000).stream.rate, 0);
    ingest(meter, "assistant.message", 3_500, { ...d, messageId: "m", content: "private response" });
    ingest(meter, "assistant.turn_end", 3_501, d);
    const done = meter.snapshot(time + 4_000);
    assert.equal(done.stream.rate, null);
    assert.equal(done.stream.series.at(-1)[1], null);
    assert.ok(done.stream.series.some(([, value]) => value > 0));
    assert.doesNotMatch(JSON.stringify(done), /private/);
    startQuery(meter, 2, 5_000);
    assert.deepEqual(meter.snapshot(time + 5_020).stream.series, []);
});

test("reports a finalized-text upper bound without inventing a live chart", () => {
    const meter = new Speedometer(sessionId);
    const d = startQuery(meter);
    ingest(meter, "assistant.message", 100, { ...d, interactionId: "other", content: "unrelated" });
    ingest(meter, "assistant.message", 250, { ...d, content: "", reasoningText: "not visible" });
    ingest(meter, "assistant.message", 1_200, { ...d, content: "real response" });
    ingest(meter, "assistant.idle", 1_210, {});
    const state = meter.snapshot(time + 1_211);
    assert.equal(state.query.firstVisibleMs, 1_200);
    assert.equal(state.query.firstVisibleSource, "message");
    assert.equal(state.query.active, false);
    assert.equal(state.stream.rate, null);
    assert.deepEqual(state.stream.series, []);
});

test("deduplicates history and live usage and keeps model TTFT and first observable output separate", () => {
    const meter = new Speedometer(sessionId);
    const usage = (sequence, data) => ({
        model: "actual", provider: { id: "copilot" }, duration: 1_200, outputTtftMs: 200,
        timeToFirstTokenMs: 100, outputTokens: 11,
        accounting: { sourceSessionId: sessionId, sequence }, ...data,
    });
    meter.setSelection("auto");
    meter.finishBackfill([
        event("session.usage_record", 1, { usage: usage(1) }),
        event("session.usage_record", 2, { usage: usage(2, { outputTtftMs: null, timeToFirstTokenMs: null }) }),
        event("session.usage_record", 3, { usage: usage(3, { interactionType: "conversation-subagent" }) }),
    ]);
    ingest(meter, "assistant.usage", 4, usage(1));
    ingest(meter, "assistant.usage", 5, usage(4, { outputTokens: 21, timeToFirstTokenMs: 300 }));
    const state = meter.snapshot(time + 6);
    assert.equal(state.selected.model, "auto");
    assert.equal(state.completedCalls, 3);
    assert.equal(state.latestCall.generationRate, 20);
    assert.equal(state.latestCall.ttft, 300);
    assert.equal(state.latestCall.outputTtft, 200);
    assert.deepEqual(state.models[0].rates, { n: 2, mean: 15, median: 15 });
    assert.deepEqual(state.models[0].ttft, { n: 2, mean: 200, median: 200 });
});

test("local journal backfills complete records only, without replaying checkpoint records", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "speedometer-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const folder = join(home, "session-state", sessionId);
    await mkdir(folder, { recursive: true });
    const receipt = event("session.usage_record", 2, { usage: { model: "test", duration: 100 } });
    await writeFile(join(folder, "events.jsonl"), [
        JSON.stringify(receipt),
        JSON.stringify({ ...receipt, id: "replay", checkpoint: true }),
        JSON.stringify(event("assistant.message_delta", 4, { deltaContent: "unavailable on disk" })),
        '{"type":"session.usage_record"',
    ].join("\n"));
    const { events, limited } = await readJournal(sessionId, home);
    assert.equal(events.length, 2);
    const meter = new Speedometer(sessionId);
    meter.finishBackfill(events, limited);
    assert.equal(meter.snapshot().completedCalls, 1);
    assert.equal(await readJournal("..", home), null);
});

test("loopback server serves its capability URL and streams sanitized metrics", async (t) => {
    const server = await startServer(new Speedometer(sessionId));
    t.after(() => server.close());
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Copilot Speedometer/);
    assert.equal((await fetch(new URL("../", server.url))).status, 404);
    const response = await fetch(new URL("events", server.url));
    const reader = response.body.getReader();
    try {
        assert.match(response.headers.get("content-type"), /text\/event-stream/);
        const { value } = await reader.read();
        const data = JSON.parse(new TextDecoder().decode(value).slice(6));
        assert.equal(data.stream.rate, null);
    } finally {
        await reader.cancel();
    }
});
