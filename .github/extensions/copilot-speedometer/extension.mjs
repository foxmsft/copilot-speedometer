import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { Speedometer } from "./metrics.mjs";
import { startServer } from "./server.mjs";
import { readJournal } from "./history.mjs";
import { SessionUsage } from "./session-usage.mjs";
import { createChildUsageReader } from "./child-usage.mjs";

const servers = new Map();
const meter = new Speedometer(process.env.SESSION_ID);
const usage = new SessionUsage();
const readChildUsage = createChildUsageReader(process.env.SESSION_ID);
let childUsage = { status: "loading" };
const dashboard = {
    snapshot: (now = Date.now(), withChart = true) => ({
        ...meter.snapshot(now, withChart), sessionUsage: usage.snapshot(), childUsage,
    }),
};
let refreshTimer;
let refreshPending = false;
let refreshing = false;
let usageError = null;
let hierarchyError = null;
let childTimer;

const session = await joinSession({
    streaming: true,
    canvases: [
        createCanvas({
            id: "copilot-speedometer",
            displayName: "Copilot Speedometer",
            description: "See generation speed, response latency, and current-session token totals by model.",
            inputSchema: { type: ["object", "null"], additionalProperties: false },
            actions: [
                {
                    name: "snapshot",
                    description: "Read the current session’s measurements and observed SDK event counts, without message text.",
                    handler: () => dashboard.snapshot(Date.now(), false),
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = startServer(dashboard).catch((error) => {
                        if (servers.get(ctx.instanceId) === entry) servers.delete(ctx.instanceId);
                        throw error;
                    });
                    servers.set(ctx.instanceId, entry);
                }
                const server = await entry;
                if (servers.size && !childTimer) childTimer = setInterval(queueMetricsRefresh, 5_000);
                queueMetricsRefresh();
                return { title: "Copilot Speedometer", url: server.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    if (!servers.size) {
                        clearInterval(childTimer);
                        childTimer = undefined;
                    }
                    await (await entry).close();
                }
            },
        }),
    ],
});

function queueMetricsRefresh() {
    refreshPending = true;
    refreshTimer ??= setTimeout(() => {
        refreshTimer = undefined;
        void refreshMetrics();
    }, 350);
}

async function refreshMetrics() {
    if (refreshing) return;
    refreshPending = false;
    refreshing = true;
    try {
        usage.setMetrics(await session.rpc.usage.getMetrics());
        usageError = null;
    } catch (error) {
        const failure = `${error.code ?? error.name}: ${error.message}`;
        if (failure !== usageError) console.error(`Speedometer session usage unavailable (${failure}); using recorded usage.`);
        usageError = failure;
        usage.useFallback();
    }
    try {
        if (servers.size) {
            childUsage = await readChildUsage(usage.snapshot());
            hierarchyError = null;
        }
    } catch (error) {
        const failure = error.code ?? error.name;
        if (failure !== hierarchyError) console.error(`Speedometer child session totals unavailable (${failure}).`);
        hierarchyError = failure;
        childUsage = { status: "unavailable" };
    } finally {
        refreshing = false;
        if (refreshPending) queueMetricsRefresh();
    }
}

// Backfill the durable receipts before applying queued live events. The same
// completion can appear as both an SDK usage event and an accounting receipt.
let pending = [];
session.on((event) => {
    usage.ingest(event);
    if (["assistant.usage", "session.usage_record", "session.usage_checkpoint", "session.idle"].includes(event.type)) {
        queueMetricsRefresh();
    }
    const received = Date.now();
    if (pending) pending.push([event, received]);
    else meter.ingest(event, "sdk", received);
});
async function loadHistory() {
    try {
        const journal = await readJournal(session.sessionId);
        if (journal) return journal;
    } catch (error) {
        console.error(`Speedometer could not read local history (${error.code ?? error.name}); trying the SDK.`);
    }
    return { events: await session.getEvents(), limited: false };
}

void loadHistory().then(
    ({ events, limited }) => {
        for (const event of events) usage.ingest(event);
        const cutoff = Math.min(...pending.map(([event]) => Date.parse(event.timestamp)).filter(Number.isFinite));
        meter.finishBackfill(events.filter((event) => Date.parse(event.timestamp) < cutoff), limited);
    },
    (error) => {
        meter.history = "unavailable";
        console.error(`Speedometer session history unavailable (${error.code ?? error.name}).`);
    },
).finally(() => {
    for (const [event, received] of pending) meter.ingest(event, "sdk", received);
    pending = null;
    queueMetricsRefresh();
    const revision = meter.selectionRevision;
    void session.rpc.model.getCurrent().then(
        ({ modelId, providerId }) => meter.setSelection(modelId, providerId, revision),
        (error) => console.error(`Speedometer could not read selected model: ${error.message}`),
    );
});
