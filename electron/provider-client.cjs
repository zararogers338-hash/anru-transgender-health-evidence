function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function validateProviderBaseUrl(value, { allowInsecureLocal = false } = {}) {
  const normalized = normalizeBaseUrl(value);
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("API 地址不是有效 URL");
  }
  if (url.username || url.password) throw new Error("API 地址不能包含用户名或密码");
  if (url.search || url.hash) throw new Error("API 地址不能包含查询参数或片段");
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(allowInsecureLocal && url.protocol === "http:" && local)) {
    throw new Error("第三方 API 必须使用 HTTPS");
  }
  return normalizeBaseUrl(url.toString());
}

function requiredTemperature(body) {
  const match = String(body || "").match(/invalid temperature:\s*only\s*(-?\d+(?:\.\d+)?)\s+is allowed/i);
  return match ? Number(match[1]) : null;
}

function reasoningPayload(protocol, effort) {
  if (!effort || effort === "provider") return {};
  if (protocol === "responses") return { reasoning: { effort } };
  if (effort === "none") return { thinking: { type: "disabled" } };
  return { thinking: { type: "enabled" }, reasoning_effort: effort };
}

async function testProvider(settings, apiKey, { allowInsecureLocal = false, onLog = () => {} } = {}) {
  const baseUrl = validateProviderBaseUrl(settings.baseUrl, { allowInsecureLocal });
  const model = String(settings.model || "").trim();
  if (!model || !apiKey) throw new Error("请完整填写 API 地址、模型和密钥");
  const protocol = settings.protocol === "responses" ? "responses" : "chat_completions";
  const endpoint = protocol === "responses" ? `${baseUrl}/responses` : `${baseUrl}/chat/completions`;
  const basePayload = protocol === "responses"
    ? { model, input: "Reply with OK", max_output_tokens: 8 }
    : { model, messages: [{ role: "user", content: "Reply with OK" }], max_tokens: 8, temperature: Number(settings.temperature ?? 0.2), stream: false };
  const send = async (payload) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    return { response, raw: await response.text() };
  };
  let payload = { ...basePayload, ...reasoningPayload(protocol, settings.reasoningEffort) };
  let result = await send(payload);
  let temperatureAdjusted = false;
  const required = protocol === "chat_completions" && !result.response.ok ? requiredTemperature(result.raw) : null;
  if (required !== null && required !== payload.temperature) {
    payload = { ...payload, temperature: required };
    temperatureAdjusted = true;
    onLog("provider", `provider requires temperature ${required}; adjusted for connection test`);
    result = await send(payload);
  }
  if (!result.response.ok) throw new Error(`Provider ${result.response.status}: ${result.raw.slice(0, 500)}`);
  return { ok: true, protocol, temperature: payload.temperature, temperatureAdjusted };
}

module.exports = { normalizeBaseUrl, reasoningPayload, requiredTemperature, testProvider, validateProviderBaseUrl };
