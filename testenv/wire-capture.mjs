// B2d wire-capture proxy: transparent pass-through from :5802 → :5801 that
// logs each request's wire-relevant fields to a JSONL file (one line per
// request). Evidence for the 3.6 preset live check (2026-09-02).
import http from "node:http";
import fs from "node:fs";

const UP_HOST = process.env.UP_HOST ?? "127.0.0.1";
const UP_PORT = Number(process.env.UP_PORT ?? "5801");
const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? "5802");
const OUT = process.argv[2];
if (!OUT) throw new Error("usage: node wire-capture.mjs <jsonl-out>");

http
	.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = null;
			}
			fs.appendFileSync(
				OUT,
				JSON.stringify({
					t: new Date().toISOString(),
					method: req.method,
					url: req.url,
					model: parsed?.model,
					max_tokens: parsed?.max_tokens,
					max_completion_tokens: parsed?.max_completion_tokens,
					reasoning_effort: parsed?.reasoning_effort,
					chat_template_kwargs: parsed?.chat_template_kwargs,
					nMessages: Array.isArray(parsed?.messages) ? parsed.messages.length : null,
				}) + "\n",
			);
			const up = http.request(
				{
					host: UP_HOST,
					port: UP_PORT,
					method: req.method,
					path: req.url,
					headers: { ...req.headers, host: `${UP_HOST}:${UP_PORT}` },
				},
				(upRes) => {
					res.writeHead(upRes.statusCode, upRes.headers);
					upRes.pipe(res);
				},
			);
			up.on("error", (e) => {
				res.writeHead(502, { "content-type": "text/plain" });
				res.end(String(e));
			});
			up.end(body);
		});
	})
	.listen(LISTEN_PORT, "127.0.0.1", () =>
		console.log(`wire capture proxy :${LISTEN_PORT} → ${UP_HOST}:${UP_PORT}, log → ${OUT}`),
	);
