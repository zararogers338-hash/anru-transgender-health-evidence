const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

test("Pi Agent Core streams a turn through an OpenAI-compatible third-party endpoint", { timeout: 30000 }, async () => {
  const providerPayloads = [];
  const provider = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    providerPayloads.push(payload);
    assert.equal(payload.model, "mock-third-party");
    assert.equal(req.headers.authorization, "Bearer test-provider-key");
    res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta: { role: "assistant", content: "安若端到端模拟回答" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta: { content: " [PMID: 12345678]" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const { PiAgentRuntime } = await import("../electron/pi-agent-runtime.mjs");
  const events = [];
  const runtime = new PiAgentRuntime({
    settings: {
      providerName: "Mock",
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
      model: "mock-third-party",
      protocol: "chat_completions",
      reasoningEffort: "none",
      temperature: 0.2,
      internetAccess: false,
    },
    apiKey: "test-provider-key",
    instructions: "You are Anru. Answer briefly.",
    webSearch: { run: async () => ({ output: "", results: [] }) },
    searchEvidence: async () => ({ results: [] }),
    onEvent: (event) => events.push(event),
  });
  try {
    await runtime.start();
    const turn = await runtime.send("请介绍跨性别健康研究");
    assert.equal(turn.status, "completed");
    const text = events.filter((event) => event.type === "chat-delta").map((event) => event.delta).join("");
    assert.match(text, /安若端到端模拟回答/);
    assert.ok(events.some((event) => event.type === "chat-complete"));
    assert.equal(providerPayloads.length, 2, "medical audit should use an independent second model pass");
    assert.match(JSON.stringify(providerPayloads[1].messages), /最终医学审稿器/);
    assert.equal(events.filter((event) => event.type === "chat-complete").length, 1, "hidden draft must not complete the visible turn");
  } finally {
    await runtime.stop();
    await new Promise((resolve) => provider.close(resolve));
  }
});

test("Pi runtime maps Anru thinking levels", async () => {
  const { thinkingLevel } = await import("../electron/pi-agent-runtime.mjs");
  assert.equal(thinkingLevel("provider"), "off");
  assert.equal(thinkingLevel("high"), "high");
  assert.equal(thinkingLevel("max"), "max");
});
