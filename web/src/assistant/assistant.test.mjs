import assert from "node:assert/strict";
import { test } from "node:test";
import "fake-indexeddb/auto";

import { complete, listModels, stream } from "./client.ts";
import { findPreset } from "./presets.ts";
import {
  CONTEXT_CHARACTER_LIMIT,
  SUGGESTED_TAG_LIMIT,
  parseTagSuggestions,
  summaryRequest,
  tagSuggestionRequest,
} from "./prompts.ts";
import { forgetAssistant, readAssistant, writeAssistant } from "../data/credentials.ts";
import { createProfile, deleteProfile, profileStorageNames } from "../data/profiles.ts";

const source = {
  title: "Rust and WASM",
  url: "https://example.com/rust-wasm",
  excerpt: "Compiling Rust to WebAssembly.",
  note: "PRIVATE_NOTE_SENTINEL",
  captured: "x".repeat(CONTEXT_CHARACTER_LIMIT * 2),
};

test("requests stay bounded, frame the page as data, and leave the note out unless asked", () => {
  const request = tagSuggestionRequest(source, false, ["rust", "wasm"]);
  assert.ok(request.prompt.length < CONTEXT_CHARACTER_LIMIT + 1_000);
  assert.ok(!request.prompt.includes("PRIVATE_NOTE_SENTINEL"));
  assert.match(request.system, /untrusted/u);
  assert.ok(request.fields.some(({ label, truncated }) => label === "Captured page" && truncated));
  assert.ok(summaryRequest(source, true).prompt.includes("PRIVATE_NOTE_SENTINEL"));
});

test("tag suggestions keep library spelling, drop current and junk tags, and are capped", () => {
  const tags = ["#Rust", "wasm", "WebAssembly", "", "<script>", "web  assembly ", "a".repeat(80), "rust"];
  const raw = `\`\`\`json\n${JSON.stringify({ tags })}\n\`\`\``;
  assert.deepEqual(parseTagSuggestions(raw, ["rust", "WebAssembly"], ["wasm"]), [
    { tag: "rust", existing: true },
    { tag: "WebAssembly", existing: true },
    { tag: "web assembly", existing: false },
  ]);
  const many = JSON.stringify(Array.from({ length: 20 }, (_, index) => `tag-${index}`));
  assert.equal(parseTagSuggestions(many, [], []).length, SUGGESTED_TAG_LIMIT);
  assert.deepEqual(parseTagSuggestions('- "systems"\n- performance', [], []).map(({ tag }) => tag), ["systems", "performance"]);
});

test("a remembered key is bound to its provider address and cannot outlive a forget", async () => {
  const profile = await createProfile(`Assistant ${crypto.randomUUID()}`);
  const { credentialDatabase } = profileStorageNames(profile.namespace);
  const settings = { version: 1, provider: "ollama", model: "llama", localBaseUrl: "http://localhost:11434/v1", disclosed: false };
  const binding = { provider: "ollama", baseURL: "http://localhost:11434/v1" };
  const bindingFor = (current) => ({ provider: current.provider, baseURL: current.localBaseUrl });

  const first = await writeAssistant(credentialDatabase, settings, { binding, apiKey: "local-key" }, 0);
  assert.equal(first.remembered, true);
  assert.equal((await readAssistant(credentialDatabase, bindingFor)).apiKey, "local-key");

  // A different address must not receive the remembered key.
  const moved = await readAssistant(credentialDatabase, () => ({ ...binding, baseURL: "http://127.0.0.1:9999/v1" }));
  assert.equal(moved.apiKey, null);
  assert.equal((await readAssistant(credentialDatabase, bindingFor)).apiKey, null);

  const { revision } = await readAssistant(credentialDatabase, bindingFor);
  await forgetAssistant(credentialDatabase, false);
  const late = await writeAssistant(credentialDatabase, settings, { binding, apiKey: "local-key" }, revision);
  assert.equal(late.remembered, false);
  assert.equal((await readAssistant(credentialDatabase, bindingFor)).apiKey, null);
  assert.equal((await readAssistant(credentialDatabase, bindingFor)).settings?.model, "llama");

  await writeAssistant(credentialDatabase, settings, { binding, apiKey: "local-key" }, late.revision);
  await createProfile(`Keep ${crypto.randomUUID()}`);
  await deleteProfile(profile.id);
  const deleted = await readAssistant(credentialDatabase, bindingFor);
  assert.equal(deleted.apiKey, null);
  assert.equal(deleted.settings, null);
});

function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const request = { system: "system", prompt: "prompt", fields: [] };

test("both wire formats complete privately, and failures are classified for the owner", async () => {
  const groq = { preset: findPreset("groq"), baseURL: findPreset("groq").baseURL, apiKey: "test-key", model: "m" };
  const seen = [];
  await withFetch(async (url, init) => {
    seen.push({ url: String(url), init });
    return Response.json({
      id: "1",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: '{"tags":["rust"]}' }, finish_reason: "stop" }],
    });
  }, async () => {
    assert.equal(await complete(groq, request), '{"tags":["rust"]}');
  });
  assert.equal(seen[0].url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(seen[0].init.credentials, "omit");
  assert.equal(seen[0].init.referrerPolicy, "no-referrer");

  // OpenAI rejects the legacy max_tokens on newer models it does not list.
  const openai = { preset: findPreset("openai"), baseURL: findPreset("openai").baseURL, apiKey: "test-key", model: "gpt-unlisted" };
  let openaiRequest;
  await withFetch(async (url, init) => {
    openaiRequest = { url: String(url), body: JSON.parse(init.body) };
    return Response.json({
      id: "1",
      object: "chat.completion",
      created: 0,
      model: "gpt-unlisted",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    });
  }, async () => {
    assert.equal(await complete(openai, request), "OK");
  });
  assert.equal(openaiRequest.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(openaiRequest.body.max_completion_tokens, 1_200);
  assert.equal(openaiRequest.body.store, false);
  assert.equal("max_tokens" in openaiRequest.body, false);

  // A Responses-only model is retried there once OpenAI says so, then remembered.
  const newest = { ...openai, model: "gpt-responses-only" };
  const calls = [];
  const responsesBody = {
    id: "resp_1",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "gpt-responses-only",
    output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return String(url).endsWith("/chat/completions")
      ? Response.json({ error: { message: "This model is only supported in v1/responses and not in v1/chat/completions.", type: "invalid_request_error" } }, { status: 404 })
      : Response.json(responsesBody);
  }, async () => {
    assert.equal(await complete(newest, request), "OK");
    assert.equal(await complete(newest, request), "OK");
  });
  assert.deepEqual(calls.map(({ url }) => url.replace("https://api.openai.com/v1/", "")), ["chat/completions", "responses", "responses"]);
  assert.equal(calls[1].body.store, false);
  assert.equal(calls[1].body.max_output_tokens, 1_200);

  await withFetch(async () => Response.json({ data: [
    { id: "gpt-old", created: 1_600_000_000 },
    { id: "text-embedding-3-large", created: 1_800_000_000 },
    { id: "gpt-newest", created: 1_790_000_000 },
  ] }), async () => {
    const models = await listModels({ preset: openai.preset, baseURL: openai.baseURL, apiKey: "test-key" });
    assert.deepEqual(models.map(({ id }) => id), ["gpt-newest", "gpt-old"]);
  });

  const anthropic = { preset: findPreset("anthropic"), baseURL: findPreset("anthropic").baseURL, apiKey: "test-key", model: "m" };
  const events = [
    ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Gist. " } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "- point" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  let headers;
  await withFetch(async (_url, init) => {
    headers = new Headers(init.headers);
    return new Response(events, { headers: { "content-type": "text/event-stream" } });
  }, async () => {
    const partials = [];
    assert.equal(await stream(anthropic, request, (text) => partials.push(text)), "Gist. - point");
    assert.deepEqual(partials, ["Gist. ", "Gist. - point"]);
  });
  assert.equal(headers.get("anthropic-dangerous-direct-browser-access"), "true");

  await withFetch(async () => Response.json({ error: { message: "Invalid key sk-abcdefghijkl" } }, { status: 401 }), async () => {
    await assert.rejects(complete(groq, request), (error) =>
      error.category === "auth" && !error.message.includes("sk-abcdefghijkl"));
  });
  await withFetch(async () => {
    throw new TypeError("Failed to fetch");
  }, async () => {
    const local = { preset: findPreset("ollama"), baseURL: "http://localhost:11434/v1", apiKey: null, model: "m" };
    await assert.rejects(complete(local, request), (error) =>
      error.category === "network" && error.message.includes("OLLAMA_ORIGINS"));
  });
});
