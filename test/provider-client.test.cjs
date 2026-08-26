const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { reasoningPayload, testProvider, validateProviderBaseUrl } = require("../electron/provider-client.cjs");

test("third-party provider URLs require HTTPS outside explicit local tests", () => {
  assert.equal(validateProviderBaseUrl("https://api.deepseek.com/"), "https://api.deepseek.com");
  assert.throws(() => validateProviderBaseUrl("http://example.com/v1"), /HTTPS/);
  assert.equal(validateProviderBaseUrl("http://127.0.0.1:8080/v1", { allowInsecureLocal: true }), "http://127.0.0.1:8080/v1");
});

test("reasoning controls map to provider protocols", () => {
  assert.deepEqual(reasoningPayload("responses", "high"), { reasoning: { effort: "high" } });
  assert.deepEqual(reasoningPayload("chat_completions", "none"), { thinking: { type: "disabled" } });
});

test("connection test retries a provider-mandated temperature", async () => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls += 1;
    if (JSON.parse(raw).temperature !== 1) {
      res.writeHead(400).end("invalid temperature: only 1 is allowed");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await testProvider({
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: "mock",
      protocol: "chat_completions",
      temperature: 0.2,
    }, "key", { allowInsecureLocal: true });
    assert.equal(result.temperature, 1);
    assert.equal(result.temperatureAdjusted, true);
    assert.equal(calls, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
