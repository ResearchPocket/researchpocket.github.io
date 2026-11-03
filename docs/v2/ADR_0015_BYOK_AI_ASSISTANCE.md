# ADR 0015: Bring-your-own-key assistance in the owner app

- Status: accepted
- Date: 2026-11-02
- Issues: [#8](https://github.com/ResearchPocket/researchpocket.github.io/issues/8) (epic),
  [#206](https://github.com/ResearchPocket/researchpocket.github.io/issues/206)
- Amends: the AI non-goals in PRODUCT.md and AGENTS.md; THREAT_MODEL.md (TM-06,
  new TM-14); WEB.md; DATA_AND_PRIVACY.md.

## Context

Tagging and re-reading long captures are the most repetitive parts of curation.
Owners asked for help with them (#8), but the product contract excludes AI
memory, profiling, RAG, autonomous organization, canonical machine-generated
tags and summaries, and silent third-party egress. A hosted ResearchPocket
model service or proxy would also reintroduce an always-on backend.

The owner application is a static GitHub Pages shell with a self-only CSP. Any
model call it makes is a new network destination from the origin that holds
the owner's GitHub token.

## Decision

### Assistance proposes; the owner decides

The hosted owner app (`/app/`) may offer assistant actions on a single open
save: **Suggest tags**, **Summarize**, and **Suggest title**. Every request
starts from an explicit owner action. There is no background, on-capture,
scheduled, or batch-unattended request, and no fallback between providers.

Output is a proposal shown in the Reader. Dismissing it changes nothing.
Accepting it performs exactly the mutation the owner could have typed:

- tags are added through the existing item edit;
- a summary is appended to the note through the existing note mutation;
- a title replaces the save's title through the existing item edit.

Each is undoable and converges like any other edit. Assistant output, prompts,
provenance, and conversation state are never stored in CRDT state, the outbox,
exports, or publications. This decision therefore changes no protocol, schema,
or sync behavior.

### Provider adapters come from a maintained library

ResearchPocket uses the Apache-2.0 [AI SDK](https://ai-sdk.dev) packages:

- `ai` for generation and streaming;
- `@ai-sdk/openai`, `@ai-sdk/anthropic`, and `@ai-sdk/google`;
- `@ai-sdk/openai-compatible` for every other provider and for local servers.

OpenAI is called through Chat Completions by default, with
`max_completion_tokens` and `store: false`. Newer models reject the legacy
`max_tokens`, and the SDK switches parameters only for model IDs it recognizes.
Some newer OpenAI models exist only on the Responses API, and OpenAI says so in
a readable error. The request is then retried once on Responses, with
`max_output_tokens` and `store: false`. That choice is remembered for the
model for the life of the page.

Chat Completions stays the default because OpenAI omits CORS headers on some
errors, such as an invalid key. The browser then sees only an opaque network
failure, and the Chat Completions path is the one verified with real keys.

Model lists are shown newest first when the provider reports creation dates,
with an option to type any model ID.

The SDK is bundled into a separate same-origin chunk and loaded only when the
owner first configures or uses the assistant, so TM-06's ban on remote runtime
code still holds. Its built-in requests use a wrapper that omits credentials,
cookies, the referrer, and HTTP caching. Requests are bounded by a timeout,
abortable, and capped in output tokens. Model listing uses one small `fetch`
per provider's `/models` endpoint.

This departs from ADR 0002's "narrow REST, no SDK" choice for Firecrawl.
Firecrawl has one endpoint. The assistant spans several wire formats, streaming,
and fast-moving provider APIs, and maintained adapters are worth the dependency.

### The network allowlist is static and reviewed

A meta-tag CSP cannot widen at runtime. `connect-src` for `/app/` therefore
lists `'self'`, `https://api.github.com`, every reviewed provider origin, the
Firecrawl page-capture origin ([ADR 0016](./ADR_0016_BROWSER_PAGE_CAPTURE.md)),
and loopback (`http://localhost:*`, `http://127.0.0.1:*`). The list lives in
`web/src/assistant/providers.json`. `check:dist` fails the build unless the
owner CSP matches it exactly and the public entries keep the GitHub-only
policy.

`upgrade-insecure-requests` is removed from `/app/` only. Every allowed source
there is already `'self'` or explicit HTTPS. The one HTTP allowance is loopback,
which the directive could otherwise rewrite to HTTPS.

A custom remote endpoint is not configurable in the page. Owners reach other
services through a gateway they run on loopback, such as LiteLLM. Relaxing
`connect-src` to `https:` was rejected: that would remove the CSP's barrier
against exfiltrating the GitHub token after a script compromise.

Verified from the `https://researchpocket.github.io` origin on 2026-11-02, using
CORS preflight plus an unauthenticated request:

| Provider | Origin | Preflight | Error responses carry CORS |
| --- | --- | --- | --- |
| OpenAI | `api.openai.com` | allowed | **no** (401 is opaque to the page) |
| Anthropic | `api.anthropic.com` | allowed with `anthropic-dangerous-direct-browser-access` | yes |
| Google Gemini | `generativelanguage.googleapis.com` | allowed | yes |
| OpenRouter | `openrouter.ai` | allowed | yes |
| Groq | `api.groq.com` | allowed | yes |
| Mistral | `api.mistral.ai` | allowed | yes |
| DeepSeek | `api.deepseek.com` | allowed | yes |
| xAI | `api.x.ai` | allowed | yes |
| Together AI | `api.together.xyz` | allowed | yes |

Because OpenAI's 401 response is opaque to the page, an invalid OpenAI key
surfaces as a network failure. The app says so explicitly.

Loopback servers must allow the app origin themselves:

- Ollama: set `OLLAMA_ORIGINS`.
- LM Studio: enable CORS.

Browsers may also ask before a public site reaches the local network: Chrome
shows a Local Network Access prompt, and Safari's mixed-content rules can block
plain-HTTP loopback. **Test and save** reports these as reachability failures,
and a loopback HTTPS gateway is the fallback.

### Keys and settings stay in this browser profile

The non-secret choice of provider, model, and loopback address is stored per
library under an `assistant` record in the existing local-only
`<profile namespace>-credentials-v1` database. Using a new record key needs no
database version change. That record also notes whether the owner has seen the
provider disclosure.

The API key is held in memory by default. With explicit **Remember key in this
browser** consent it is saved in the same record, following ADR 0013:

- The saved key is bound to the provider and address it was tested against; a
  binding mismatch discards it.
- **Forget key** and **Turn off assistant** clear it across tabs through a
  broadcast that carries only an invalidation command.
- Deleting the profile removes the record.
- A non-secret revision rejects a remember that started before a forget.

Settings and keys are never synced: they do not enter the library replica,
outbox, protocol objects, exports, logs, service-worker caches, URLs, or
publication artifacts.

### Payloads are declared, bounded, and disclosed

Each feature builds its request in `web/src/assistant/prompts.ts`. Before
sending, the Reader names every field in shorthand, the total size, whether
anything was trimmed, and the provider, with its full address on hover; for
example, "Sends title, URL, excerpt, tags · 1.6k → OpenAI". The one line covers
every Reader action, so it lists tag names even though only **Suggest tags**
sends them.

| Feature | Sends |
| --- | --- |
| Suggest tags | title, URL, excerpt, bounded captured Markdown, and up to 200 of the owner's tag names, busiest first |
| Summarize | the same fields, without the tag names |
| Suggest title | the same fields as Summarize, plus the suggestion being passed over when asking for another |
| Zen title | the document, up to 16,000 characters, plus its current title when asking for another |
| Zen continue writing | the document up to the cursor (its last 16,000 characters) |
| Zen improve or shorten | only the selected text |
| Zen summarize or extract todos | the document, up to 16,000 characters |
| Zen draft from linked saves | the last 4,000 characters of the document, plus the title, URL, and excerpt (up to 1,500 characters each) of up to 20 saves the document links to |

The private note is excluded unless the owner ticks **Include my note** for
that request. Context is capped at 24,000 characters, with truncation marked
in the preview.

The first request to a provider shows a one-time confirmation naming the
destination and stating that its data policy applies.

Zen documents are the owner's own private writing. Each Zen action names what
it sends in its menu entry before it is chosen. Linked saves contribute only
their title, URL, and excerpt, never their notes. Results are placed only by an
explicit **Replace selection**, **Insert at cursor**, or **Add to end**, as one
ordinary body edit. A result is offered only at the end of the document if the
body changed while it was being written.

### Model output is untrusted

Saved pages can contain prompt injection, so prompts frame page content as
untrusted data. Output is handled as untrusted too:

- **Tags:** parsed leniently, trimmed, stripped of `#`, rejected if markup-like
  or longer than 48 characters, de-duplicated against the save, mapped to the
  library's existing spelling, and capped at eight.
- **Summaries:** rendered through the existing Markdown renderer with images
  inert.
- **Titles:** reduced to the first non-empty line, stripped of quotes,
  Markdown markers, and a trailing period, shown as plain text, and rejected
  above 120 characters.
- **No tools:** model output never executes or calls a tool, and is never
  applied without an explicit accept.

## Alternatives considered

- **kalosm or another in-browser inference runtime.** Rejected for the PWA.
  Model weights are hundreds of megabytes to gigabytes, WebGPU support is
  uneven, and it would not cover hosted models. Local models are supported
  through loopback servers instead.
- **Hosted ResearchPocket proxy.** Rejected. It is an always-on backend, a
  shared key, and a party that sees every library payload.
- **Hand-written REST adapters.** Rejected. They would mean tracking several
  fast-changing wire formats and streaming dialects without upstream
  maintenance.
- **Syncing keys or settings through the private repository.** Rejected.
  Secrets never enter the repository, and per-device choices (local servers,
  trust in a browser) are not library data.
- **Chrome's built-in Prompt API.** Deferred. It is a candidate future
  on-device adapter once it is broadly available to web pages.

## Consequences

- Owners can use hosted providers or local servers without installing anything
  beyond the static app. An owner who never enables the assistant downloads no
  SDK code.
- The owner origin can now reach nine third-party API origins. The threat model
  records this as TM-14. Adding an origin needs a reviewed registry entry and a
  CORS check.
- Assistant features remain owner-app only. CLI/TUI parity is a later decision
  and can reuse the same prompt and parsing contracts.
- Owners who change their mind just stop accepting suggestions or turn the
  assistant off. There is nothing to migrate or roll back.

## Verification

- `web/src/assistant/assistant.test.mjs` covers four contracts:
  - request bounds and note exclusion;
  - tag normalization;
  - remembered-key binding, forget races, and profile deletion;
  - a stubbed-`fetch` run through the real SDK adapters for the OpenAI-compatible
    and Anthropic wire formats, including privacy request options and failure
    classification.
- `check:dist` enforces the owner and public `connect-src` lists.
