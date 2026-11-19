const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const duration = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const fields = ["input", "output", "calls"];
const sum = (a, b) => a == null ? b : b == null ? a : a + b;

function row(model, name, provider, usage, calls) {
    return {
        model, name: name || model || "Unattributed model", provider,
        input: count(usage?.inputTokens), output: count(usage?.outputTokens), calls: count(calls),
    };
}

function providerRows(metrics) {
    return metrics.map((m) => ({
        ...row(m.modelId, m.modelDisplayName, m.provider?.label || m.provider?.id || null, m.metrics?.usage, m.metrics?.requests?.count),
        providerId: m.provider?.id ?? null,
    }));
}

export function withTotals(rows, source, extras = {}) {
    const models = rows.map((r) => ({ ...r, total: r.input == null || r.output == null ? null : r.input + r.output }))
        .sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.name.localeCompare(b.name));
    const totals = {};
    for (const k of fields) {
        totals[k] = models.some((m) => m[k] == null) ? null : models.reduce((acc, m) => acc + m[k], 0);
    }
    totals.total = totals.input == null || totals.output == null ? null : totals.input + totals.output;
    return { source, models, ...totals, userRequests: null, apiDurationMs: null, ...extras };
}

export function mergeUsageRows(rows) {
    const models = new Map();
    for (const row of rows) {
        const key = JSON.stringify([row.model ?? null, row.providerId ?? null]);
        const previous = models.get(key);
        models.set(key, previous ? {
            ...previous,
            ...Object.fromEntries(fields.map((k) => [k, previous[k] == null || row[k] == null ? null : previous[k] + row[k]])),
        } : row);
    }
    return [...models.values()];
}

export class SessionUsage {
    #sdk = null;
    #checkpoint = null;
    #seen = new Set();
    #calls = new Map();
    #fallback = null;
    #loading = true;

    setMetrics(result) {
        if (!result?.modelMetrics || typeof result.modelMetrics !== "object") {
            throw new TypeError("Session usage metrics did not include model metrics");
        }
        const rows = result.providerModelMetrics?.length ? providerRows(result.providerModelMetrics)
            : Object.entries(result.modelMetrics).filter(([, m]) => m).map(([id, m]) =>
                row(id, null, null, m.usage, m.requests?.count));
        this.#sdk = withTotals(rows, "sdk", {
            userRequests: count(result.totalUserRequests), apiDurationMs: duration(result.totalApiDurationMs),
        });
        this.#loading = false;
    }

    useFallback() {
        this.#sdk = null;
        this.#loading = false;
    }

    ingest({ id, type, data, timestamp, checkpoint }) {
        if (type === "session.usage_checkpoint") {
            const at = Date.parse(timestamp);
            if (!data?.providerModelMetrics?.length || !data.usageAccountingWatermarks
                || !Number.isFinite(at) || (this.#checkpoint && at < this.#checkpoint.at)) return;
            this.#checkpoint = {
                at, rows: providerRows(data.providerModelMetrics),
                watermarks: new Map(Object.entries(data.usageAccountingWatermarks)),
            };
            this.#fallback = null;
            return;
        }
        if (checkpoint || (type !== "assistant.usage" && type !== "session.usage_record")) return;
        const usage = type === "assistant.usage" ? data : data?.usage;
        if (!usage) return;
        const { sourceSessionId, sequence, usageId } = usage.accounting ?? {};
        const seq = sourceSessionId && Number.isSafeInteger(sequence) ? `${sourceSessionId}:${sequence}` : null;
        // Prefer the runtime accounting identity; for older events fall back to the
        // completion ID (not the provider request ID, which can span several calls).
        const completion = usageId || usage.apiCallId;
        const key = seq ? `seq:${seq}` : completion ? `call:${completion}` : id ? `event:${id}` : null;
        if (!key || this.#seen.has(key)) return;
        this.#seen.add(key);
        const completionKey = completion ? `call:${completion}` : null;
        if (completionKey && key !== completionKey) {
            this.#seen.add(completionKey);
            this.#calls.delete(completionKey);
        }
        const provider = usage.provider?.label || usage.provider?.id || null;
        this.#calls.set(key, {
            at: Date.parse(timestamp), sourceSessionId, sequence, seq,
            row: row(usage.model ?? null, usage.modelDisplayName, provider, usage, 1),
            providerId: usage.provider?.id ?? null,
        });
        this.#fallback = null;
    }

    snapshot() {
        if (this.#sdk) return this.#sdk;
        if (this.#loading) return { source: "loading", models: [] };
        if (this.#fallback) return this.#fallback;
        const checkpoint = this.#checkpoint;
        const rows = new Map();
        const add = (r) => {
            const key = JSON.stringify([r.model, r.providerId]);
            const old = rows.get(key);
            rows.set(key, old ? {
                ...r, ...Object.fromEntries(fields.map((k) => [k, sum(old[k], r[k])])),
            } : r);
        };
        for (const r of checkpoint?.rows ?? []) add(r);
        for (const call of this.#calls.values()) {
            if (checkpoint && (call.seq ? call.sequence <= (checkpoint.watermarks.get(call.sourceSessionId) ?? -1)
                : call.at <= checkpoint.at)) continue;
            add({ ...call.row, providerId: call.providerId });
        }
        return this.#fallback = rows.size ? withTotals([...rows.values()], "recorded") : { source: "unavailable", models: [] };
    }
}
