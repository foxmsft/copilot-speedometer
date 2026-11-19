import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readJournal } from "../.github/extensions/copilot-speedometer/history.mjs";
import { Speedometer } from "../.github/extensions/copilot-speedometer/metrics.mjs";
import { startServer } from "../.github/extensions/copilot-speedometer/server.mjs";

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
