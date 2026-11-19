export const STEP_MS = 250;
export const WINDOW_MS = 2_000;
export const CHART_MS = 30_000;
export const CALL_LIMIT = 1_000;
const BYTES_PER_TOKEN = 4;

const nonnegative = (n) => (Number.isFinite(n) && n >= 0 ? n : null);
const elapsed = (end, start) => (start == null ? null : nonnegative(end - start));
const hasText = (text) => typeof text === "string" && /\S/u.test(text);
const isUsage = (type) => type === "assistant.usage" || type === "session.usage_record";

function distribution(values) {
    const sorted = values.filter((x) => x != null).sort((a, b) => a - b);
    const n = sorted.length;
    return n === 0 ? { n, mean: null, median: null } : {
        n,
        mean: sorted.reduce((sum, x) => sum + x, 0) / n,
        median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2,
    };
}

export class Speedometer {
    #sessionId;
    #query = null;
    #queryNumber = 0;
    #turn = null;
    #selection = { model: null, provider: null };
    #selectionRevision = 0;
    #calls = new Map();
    #seen = new Set();
    #segments = [];
    #stream = null;
    #stats = null;
    #counts = { deltas: 0, usage: 0, receipts: 0, finalMessages: 0 };
    history = "loading";

    constructor(sessionId) {
        this.#sessionId = sessionId;
    }

    get selectionRevision() {
        return this.#selectionRevision;
    }

    setSelection(model, provider, revision = this.#selectionRevision) {
        if (revision !== this.#selectionRevision) return;
        this.#selection = { model: model || null, provider: provider || null };
        this.#selectionRevision++;
    }

    finishBackfill(events, limited = false) {
        for (const event of events) this.ingest(event, "history");
        this.history = limited ? "limited" : "loaded";
    }

    ingest(event, source = "sdk", received = Date.now()) {
        const { type, data: d, id } = event;
        if (!d || event.checkpoint || event.agentId || d.parentToolCallId) return;
        const at = Date.parse(event.timestamp);
        if (!Number.isFinite(at)) return;
        const live = source === "sdk";
        const handled = isUsage(type) || [
            "user.message", "assistant.turn_start", "assistant.turn_end", "assistant.message",
            "assistant.message_delta", "assistant.idle", "session.idle", "abort",
            "session.model_change", "session.model_deselected", "session.start",
        ].includes(type);
        if (!handled) return;
        if (isUsage(type) && live) {
            if (type === "assistant.usage") this.#counts.usage++;
            else this.#counts.receipts++;
        }
        if (id && this.#seen.has(id)) return;
        if (id) {
            this.#seen.add(id);
            if (this.#seen.size > 20_000) this.#seen.delete(this.#seen.values().next().value);
        }
        switch (type) {
            case "session.start":
                if (!this.#selectionRevision && d.selectedModel) this.setSelection(d.selectedModel);
                break;
            case "session.model_change":
                this.setSelection(d.newModel, d.providerId);
                break;
            case "session.model_deselected":
                this.setSelection(null, null);
                break;
            case "user.message":
                if (d.isAutopilotContinuation || d.source === "autopilot" || d.source?.startsWith("skill-")) break;
                this.#closeSegment(received);
                this.#segments = [];
                this.#turn = null;
                this.#query = {
                    number: ++this.#queryNumber, startedAt: at, interaction: d.interactionId,
                    startTurn: d.turnId, firstVisible: null, firstSource: null, deltas: 0,
                    active: live, model: null,
                };
                break;
            case "assistant.turn_start":
                this.#closeSegment(received);
                this.#turn = { id: d.turnId, interaction: d.interactionId };
                if (this.#matchesQuery()) {
                    this.#query.active = live;
                    if (d.model) this.#query.model = d.model;
                }
                break;
            case "assistant.message_delta": {
                if (!live || typeof d.deltaContent !== "string" || !d.deltaContent.length) break;
                this.#counts.deltas++;
                if (!this.#matchesQuery()) break;
                if (!this.#stream && !hasText(d.deltaContent)) break;
                this.#query.active = true;
                if (!this.#stream) {
                    this.#stream = { start: received, end: null, message: d.messageId, chunks: new Map() };
                    this.#segments.push(this.#stream);
                }
                if (this.#stream.message !== d.messageId) break;
                this.#query.deltas++;
                this.#firstVisible(at, "delta");
                const bucket = Math.floor(received / STEP_MS) * STEP_MS;
                const { chunks } = this.#stream;
                chunks.set(bucket, (chunks.get(bucket) ?? 0) + Buffer.byteLength(d.deltaContent));
                for (const time of chunks.keys()) {
                    if (received - time <= CHART_MS + WINDOW_MS + STEP_MS) break;
                    chunks.delete(time);
                }
                this.#segments = this.#segments.filter((span) => span.end == null || received - span.end <= CHART_MS);
                break;
            }
            case "assistant.message":
                if (live) this.#counts.finalMessages++;
                if (this.#matchesQuery(d.turnId, d.interactionId) && hasText(d.content)) this.#firstVisible(at, "message");
                if (this.#stream?.message === d.messageId) this.#closeSegment(received);
                break;
            case "assistant.turn_end":
                if (this.#turn?.id === d.turnId) {
                    if (this.#matchesQuery() && d.model) this.#query.model = d.model;
                    this.#closeSegment(received);
                    this.#turn = null;
                }
                break;
            case "assistant.idle":
            case "session.idle":
            case "abort":
                this.#closeSegment(received);
                this.#turn = null;
                if (this.#query) this.#query.active = false;
                break;
            case "assistant.usage":
            case "session.usage_record":
                this.#recordCall(type === "assistant.usage" ? d : d.usage, type, id, at);
                break;
        }
    }

    #matchesQuery(turnId, interaction) {
        const q = this.#query;
        if (q?.interaction && interaction) return q.interaction === interaction;
        if (!q || !this.#turn || (turnId && turnId !== this.#turn.id)) return false;
        if (q.interaction && this.#turn.interaction) return q.interaction === this.#turn.interaction;
        return !q.startTurn || this.#turn.id === q.startTurn;
    }

    #firstVisible(at, source) {
        const q = this.#query;
        const ms = elapsed(at, q.startedAt);
        if (q.firstVisible == null && ms != null) {
            q.firstVisible = ms;
            q.firstSource = source;
        }
    }

    #closeSegment(at) {
        if (!this.#stream) return;
        this.#stream.end = at;
        this.#stream = null;
    }

    #recordCall(d, type, id, at) {
        if (!d?.model || (d.accounting?.sourceSessionId && d.accounting.sourceSessionId !== this.#sessionId)
            || (d.interactionType && !["conversation-agent", "conversation-user"].includes(d.interactionType))
            || (d.initiator && !["agent", "user"].includes(d.initiator))) return;
        const measured = type === "assistant.usage";
        const { sourceSessionId, sequence, usageId } = d.accounting ?? {};
        const apiCallId = usageId || d.apiCallId;
        const key = sourceSessionId && Number.isInteger(sequence) ? `sequence:${sourceSessionId}:${sequence}`
            : apiCallId ? `call:${apiCallId}` : `event:${id}`;
        const previous = this.#calls.get(key);
        if (previous?.source === "sdk" || (previous && !measured)) return;
        const duration = nonnegative(d.duration);
        const outputTtft = nonnegative(d.outputTtftMs);
        const ttft = nonnegative(d.timeToFirstTokenMs);
        const outputTokens = nonnegative(d.outputTokens);
        const generationMs = duration != null && outputTtft != null && duration > outputTtft
            ? duration - outputTtft : null;
        this.#calls.set(key, {
            at: previous?.at ?? at, source: measured ? "sdk" : "receipt",
            model: d.model, name: d.modelDisplayName || d.model, provider: d.provider?.id ?? null,
            duration, outputTtft, ttft, outputTokens, generationMs,
            generationRate: generationMs != null && outputTokens > 1 ? 1_000 * (outputTokens - 1) / generationMs : null,
        });
        if (this.#calls.size > CALL_LIMIT) this.#calls.delete(this.#calls.keys().next().value);
        this.#stats = null;
    }

    #callStats() {
        if (this.#stats) return this.#stats;
        const grouped = new Map();
        let latestCall = null;
        for (const call of this.#calls.values()) {
            if (!latestCall || call.at >= latestCall.at) latestCall = call;
            const key = JSON.stringify([call.model, call.provider]);
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(call);
        }
        const models = [...grouped.values()].map((calls) => {
            const { model, name, provider } = calls.at(-1);
            return {
                model, name, provider, calls: calls.length,
                rates: distribution(calls.map((c) => c.generationRate)),
                ttft: distribution(calls.map((c) => c.ttft)),
                duration: distribution(calls.map((c) => c.duration)),
            };
        }).sort((a, b) => a.name.localeCompare(b.name) || (a.provider ?? "").localeCompare(b.provider ?? ""));
        return this.#stats = { latestCall, models, completedCalls: this.#calls.size };
    }

    snapshot(now = Date.now(), withChart = true) {
        const query = this.#query;
        const currentBucket = Math.floor(now / STEP_MS) * STEP_MS;
        const rate = (at, span) => {
            let bytes = 0;
            // Sum the trailing window using a 250 ms grid, rather than counting chunks as tokens.
            for (let bucket = at - WINDOW_MS + STEP_MS; bucket <= at; bucket += STEP_MS) {
                bytes += span.chunks.get(bucket) ?? 0;
            }
            const seconds = Math.min(WINDOW_MS, Math.max(STEP_MS, at + STEP_MS - span.start)) / 1_000;
            return bytes / BYTES_PER_TOKEN / seconds;
        };
        const series = [];
        if (withChart && this.#segments.length) {
            for (let t = currentBucket - CHART_MS; t <= currentBucket; t += STEP_MS) {
                const span = this.#segments.findLast(({ start, end }) => start < t + STEP_MS && (end == null || end >= t));
                series.push([t, span ? rate(t, span) : null]);
            }
        }
        return {
            now, history: this.history, selected: this.#selection,
            query: query && {
                number: query.number, active: query.active, model: query.model,
                firstVisibleMs: query.firstVisible, firstVisibleSource: query.firstSource,
                elapsedMs: query.active ? elapsed(now, query.startedAt) : null,
                deltaCount: query.deltas,
            },
            stream: { rate: this.#stream ? rate(currentBucket, this.#stream) : null, series },
            signals: { ...this.#counts },
            ...this.#callStats(),
        };
    }
}
