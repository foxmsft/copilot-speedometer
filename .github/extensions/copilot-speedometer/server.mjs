import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { STEP_MS } from "./metrics.mjs";

const assets = new Map([
    ["", ["index.html", "text/html"]],
    ["speedometer.css", ["speedometer.css", "text/css"]],
    ["speedometer.js", ["speedometer.js", "text/javascript"]],
]);

export async function startServer(meter) {
    const base = `/${randomBytes(24).toString("base64url")}/`;
    const files = new Map(await Promise.all([...assets].map(async ([route, [file, type]]) => [
        base + route, { body: await readFile(new URL(file, import.meta.url)), type },
    ])));
    const clients = new Set();
    let timer;
    let authority;
    const server = createServer((req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        if (req.method !== "GET" || req.headers.host !== authority) {
            res.writeHead(404).end();
            return;
        }
        const file = files.get(req.url);
        if (file) {
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'");
            res.writeHead(200, { "Content-Type": `${file.type}; charset=utf-8` }).end(file.body);
        } else if (req.url === `${base}events` && clients.size < 8) {
            res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
            clients.add(res);
            res.on("close", () => {
                clients.delete(res);
                if (!clients.size) {
                    clearInterval(timer);
                    timer = undefined;
                }
            });
            send(res, frame());
            timer ??= setInterval(() => {
                const next = frame();
                for (const client of clients) send(client, next);
            }, STEP_MS);
        } else {
            res.writeHead(404).end();
        }
    });
    const frame = () => `data: ${JSON.stringify(meter.snapshot())}\n\n`;
    const send = (res, data) => {
        if (res.writableLength > 128_000) res.destroy();
        else res.write(data);
    };
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    server.on("error", (error) => console.error(`Speedometer loopback server error: ${error.message}`));
    authority = `127.0.0.1:${server.address().port}`;
    return {
        url: `http://${authority}${base}`,
        close: () => new Promise((resolve, reject) => {
            clearInterval(timer);
            for (const client of clients) client.destroy();
            server.close((error) => error ? reject(error) : resolve());
            server.closeIdleConnections();
        }),
    };
}
