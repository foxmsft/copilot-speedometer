"use strict";

const el = (id) => document.getElementById(id);
const set = (id, value) => {
    const node = el(id);
    if (node.textContent !== value) node.textContent = value;
};
const missing = "\u2014";
const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const number = (n) => n == null ? missing : format.format(n);
const ms = (n) => n == null ? missing : n < 1_000 ? `${Math.round(n)} ms` : `${number(n / 1_000)} s`;
const pair = ({ n, mean, median }, display) => n ? `${display(mean)} / ${display(median)} (${n})` : missing;
const scaleFor = (peak) => Math.max(100, Math.ceil(peak / 100) * 100);
let modelTableKey;

function renderModels(models, selected) {
    const key = JSON.stringify([models, selected]);
    if (key === modelTableKey) return;
    modelTableKey = key;
    const rows = models.map((m) => {
        const row = document.createElement("tr");
        const isSelected = m.model === selected.model && (!selected.provider || selected.provider === m.provider);
        row.classList.toggle("selected", isSelected);
        const label = document.createElement("th");
        label.scope = "row";
        label.textContent = m.provider && m.provider !== "copilot" ? `${m.name} (${m.provider})` : m.name;
        if (isSelected) label.setAttribute("aria-label", `${label.textContent}, selected model`);
        row.append(label);
        for (const value of [m.calls, pair(m.rates, number), pair(m.ttft, ms), pair(m.duration, ms)]) {
            const cell = row.insertCell();
            cell.textContent = value;
        }
        return row;
    });
    if (!rows.length) {
        const row = document.createElement("tr");
        const cell = row.insertCell();
        cell.colSpan = 5;
        cell.textContent = "No calls measured.";
        rows.push(row);
    }
    el("models").replaceChildren(...rows);
}

function render({ selected, query, stream, latestCall, models, history, signals }) {
    set("selected", selected.model === "auto" ? "Auto" : selected.model || "Unknown");
    const max = scaleFor(Math.max(stream.rate ?? 0, ...stream.series.map(([, rate]) => rate ?? 0)));
    set("rate", number(stream.rate));
    set("gauge-max", format.format(max));
    set("chart-max", format.format(max));
    const ratio = 100 * (stream.rate ?? 0) / max;
    el("needle").setAttribute("stroke-dasharray", `${ratio} 100`);
    el("needle").setAttribute("visibility", ratio > 0 ? "visible" : "hidden");
    set("mode", stream.rate != null ? "Live from visible SDK deltas."
        : query?.deltaCount ? "No active text stream."
            : query?.active ? "Waiting for visible deltas; completed-call metrics only so far."
                : "Completed-call only until visible deltas arrive.");

    set("query", query ? `Query #${query.number}${query.model ? ` \u00b7 ${query.model}` : ""}${query.active ? " \u00b7 In progress" : ""}` : "No query observed yet.");
    set("latency", query?.firstVisibleSource === "message" ? `\u2264 ${ms(query.firstVisibleMs)}` : ms(query?.firstVisibleMs));
    set("latency-source", query?.firstVisibleSource === "delta" ? "Query admission to first visible SDK delta."
        : query?.firstVisibleSource === "message" ? "Upper bound from the first finalized message; live deltas not observed for that message."
            : query?.active ? `No visible text yet \u00b7 ${ms(query.elapsedMs)} since query admission.` : "");

    let drawing = false;
    let path = "";
    for (const [index, [, y]] of stream.series.entries()) {
        if (y == null) {
            drawing = false;
            continue;
        }
        const x = 45 + index * 545 / (stream.series.length - 1);
        const point = `${x.toFixed(2)} ${(108 - y * 96 / max).toFixed(2)}`;
        path += drawing ? `L${point}` : `M${point}h.01`;
        drawing = true;
    }
    el("line").setAttribute("d", path);
    set("latest", latestCall
        ? `${latestCall.name} \u00b7 ${latestCall.source === "sdk" ? "SDK usage" : "session usage receipt"} \u00b7 ${number(latestCall.outputTokens)} reported output tokens`
        : "No completed calls observed.");
    set("completed-rate", latestCall?.generationRate == null ? missing : `${number(latestCall.generationRate)} tok/s`);
    set("ttft", ms(latestCall?.ttft));
    set("generation", ms(latestCall?.generationMs));
    set("duration", ms(latestCall?.duration));
    renderModels(models, selected);
    set("history", history === "unavailable" ? "Session history unavailable; showing newly observed calls only."
        : history === "limited" ? "Older calls may be unavailable; history is limited to the last 8 MiB of the session journal."
        : history === "loading" ? "Loading available session history..." : "");
    set("signals", `Observed on SDK connection: ${signals.deltas} visible deltas, ${signals.usage} usage events, ${signals.receipts} receipts, ${signals.finalMessages} finalized messages.`);
}

const events = new EventSource("events");
events.onmessage = ({ data }) => {
    render(JSON.parse(data));
    set("connection", "Connected to local session");
};
events.onerror = () => {
    set("connection", "Reconnecting; measurements below may be stale.");
    set("rate", missing);
    el("needle").setAttribute("visibility", "hidden");
};
