import http from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.argv[2] ?? 0);
if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error("fake-model-server: missing/invalid port (argv[2])");
  process.exit(2);
}
const MODEL = process.env.LLS_FAKE_MODEL ?? "fake-model";
const LOG = process.env.LLS_FAKE_LOG;
const REPLY = process.env.LLS_FAKE_REPLY ?? "PONG";

function logRequest(entry) {
  if (!LOG) return;
  try {
    appendFileSync(LOG, JSON.stringify(entry) + "\n");
  } catch {
    // logging is best-effort; never fail a request on a log write
  }
}

// Streams when asked: the pi-ai openai-completions client streams and needs well-formed SSE.
function completionBody(model, stream) {
  if (!stream) {
    return {
      id: `chatcmpl-${MODEL}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: REPLY },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
    };
  }
  // SSE `data:` lines only (no standalone `id:`/`object:` header lines —
  // llama-swap's stream metrics parser reports them as "no valid JSON").
  const delta = (content, finish, usage) =>
    `data: ${JSON.stringify({
      id: `chatcmpl-${MODEL}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: content ? { role: "assistant", content } : {},
          finish_reason: finish,
        },
      ],
      ...(usage ?? {}),
    })}\n\n`;
  return (
    delta(REPLY, null) +
    delta(null, "stop", {
      usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
    })
  );
}

const server = http.createServer((req, res) => {
  const url = (req.url ?? "").split("?")[0];
  // llama-swap's readiness probe (default checkEndpoint /health → 200).
  if (req.method === "GET" && (url === "/health" || url === "/v1/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.method === "GET" && url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          {
            id: MODEL,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "fake",
          },
        ],
      }),
    );
    return;
  }
  if (req.method === "POST" && url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      // THE wire fact the e2e asserts on: the full request as modelspoke/pi-ai
      // sent it, plus the auth/attribution headers.
      logRequest({
        at: new Date().toISOString(),
        model: MODEL,
        headers: {
          authorization: req.headers["authorization"] ?? null,
          "user-agent": req.headers["user-agent"] ?? null,
          ...Object.fromEntries(
            Object.entries(req.headers).filter(
              ([k]) => k.startsWith("x-modelspoke") || k === "attribution",
            ),
          ),
        },
        body: parsed ?? body,
      });
      if (parsed && parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(completionBody(MODEL, true) + "data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(completionBody(MODEL, false)));
      }
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `fake-model-server: no route for ${req.method} ${url}` } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`fake-model-server ${MODEL} listening on 127.0.0.1:${PORT}`);
});
