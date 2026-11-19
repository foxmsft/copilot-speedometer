# Copilot Speedometer

A dependency-free canvas for the local GitHub Copilot desktop app. It measures the current session, not every open chat. In a new session, ask Copilot to **open Copilot Speedometer**, then send a prompt with the canvas open.

## Install for all local sessions

From the repository root in PowerShell:

```powershell
.\Install-Speedometer.ps1
```

The script copies the extension to `$env:COPILOT_HOME\extensions\copilot-speedometer` (default: `~\.copilot\extensions\copilot-speedometer`). It never overwrites an existing installation. Reload extensions in an existing session or start a new one. The repo's project copy takes precedence within this repo. To uninstall, move the user extension directory out of `extensions` and reload.

## Reading the canvas

| Metric | What it measures |
| --- | --- |
| Visible speed | Estimated visible tokens per second from `assistant.message_delta`. Updated every 250 ms, with a trailing window of up to 2 s and a 30 s chart. UTF-8 bytes / 4 is a rough estimate, not the model tokenizer. Chunk batching and language affect the reading. No visible deltas means no live rate. |
| First visible response | From SDK `user.message` admission (not the Send click) to the first nonblank visible delta. When only a completed assistant message arrives, its timestamp provides an upper bound (`≤`). |
| Completed generation | Estimated rate after the first observable model output: `(reported output tokens − 1) / (call duration − output TTFT)`. The usage count may include reasoning or tool output; this is **not** the visible speed. Missing timings or fewer than two output tokens leave the rate blank. |
| Model TTFT and duration | Reported API-call measurements from `assistant.usage`; not user-visible response latency. Per-model mean and median include individual sample counts. |

Auto is shown as the selected mode; completed calls and averages use the model reported for the actual call. Subagents and background usage are excluded when identified. The last 1,000 calls are summarized; the current local session journal can restore completed usage and finalized-message timings after reload (up to its last 8 MiB). Live and durable usage records are deduplicated by accounting identity. The SDK history is a fallback when a local journal cannot be read. Live deltas are transient and cannot be reconstructed.

**Session statistics** use Copilot’s accumulated usage for the current conversation, including resumed usage and any subagent calls Copilot attributes to it. The panel shows accounted model calls, user-initiated API requests, cumulative model API time, and input, output, and total tokens by model and across the session. Cached tokens are already part of input, and reasoning tokens can already be part of output; neither is added again. Input counts each call’s context, including repeated context. If Copilot cannot report its totals, the panel labels the recorded subtotal from available checkpoints and usage events as potentially incomplete.

**Include child sessions** is checked when the canvas opens. It adds tokens and model call counts from verified local sidebar descendants, including nested children. Uncheck it to see only the current session’s usage. Speed, response latency, user-initiated API requests, and cumulative API time stay scoped to the current session. While open, the panel checks for newly completed child calls about every five seconds. The extension reads the desktop app’s local sidebar relationship database in read-only mode and inspects usage receipts for related sessions only. If that schema is unavailable, or cloud, remote, missing, or truncated journals prevent a verified total, the panel reports unavailable or partial coverage rather than counting missing data as zero.

The extension uses an ephemeral loopback server and makes no external network requests. It does not display or keep prompt, response, reasoning, or tool text. It reads only enough text to identify visible chunks and count their bytes.

## Development

Run `node --test` with a current Node.js version. Reload extensions in the app after editing the project copy. The `snapshot` canvas action reports sanitized metrics and observed event counters, useful for distinguishing actual SDK streaming from completed-only delivery.
