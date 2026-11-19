import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { Speedometer } from "./metrics.mjs";
import { startServer } from "./server.mjs";
import { readJournal } from "./history.mjs";

const servers = new Map();
const meter = new Speedometer(process.env.SESSION_ID);

const session = await joinSession({
    streaming: true,
    canvases: [
        createCanvas({
            id: "copilot-speedometer",
            displayName: "Copilot Speedometer",
            description: "See this session’s live visible generation speed, response latency, and per-model averages.",
            inputSchema: { type: ["object", "null"], additionalProperties: false },
            actions: [
                {
                    name: "snapshot",
                    description: "Read the current session’s measurements and observed SDK event counts, without message text.",
                    handler: () => meter.snapshot(Date.now(), false),
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = startServer(meter).catch((error) => {
                        if (servers.get(ctx.instanceId) === entry) servers.delete(ctx.instanceId);
                        throw error;
                    });
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Copilot Speedometer", url: (await entry).url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await (await entry).close();
                }
            },
        }),
    ],
});

// Backfill the durable receipts before applying queued live events. The same
// completion can appear as both an SDK usage event and an accounting receipt.
let pending = [];
session.on((event) => {
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
    const revision = meter.selectionRevision;
    void session.rpc.model.getCurrent().then(
        ({ modelId, providerId }) => meter.setSelection(modelId, providerId, revision),
        (error) => console.error(`Speedometer could not read selected model: ${error.message}`),
    );
});
