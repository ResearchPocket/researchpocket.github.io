# Assistant

The browser workspace can suggest tags and draft summaries for a save using a
model provider you choose and pay for yourself. It is off until you set it up.
It never runs on its own, and nothing it produces enters your library until you
accept it.

## Set up a provider

1. Open **Settings** and find **Assistant**.
2. Choose a provider:
   - **Hosted with your key:** OpenAI, Anthropic, Google Gemini, OpenRouter,
     Groq, Mistral, DeepSeek, xAI, or Together AI. Use **Get a key** to open
     the provider's key page.
   - **Running on this computer:** Ollama, LM Studio, or any other
     OpenAI-compatible server on `http://localhost` or `http://127.0.0.1`.
3. Paste your API key. Local servers usually need none.
4. Pick a model. The list loads when you leave the key field, or when you choose
   **Load models**, and shows the provider's newest releases first. Choose
   **Type a model ID…** to use a model that isn't listed.
5. Choose **Test and save**. ResearchPocket sends one tiny request to check the
   key, the model, and the connection, and saves the setup only if it works.

Your key stays in this tab's memory unless you tick **Remember key in this
browser**. Only remember it in a browser you trust: anyone with access to this
browser profile could use it. The setup is kept per library, in this browser
only. It is never synced, exported, or published.

### Local servers

The browser connects straight to your server, so the server has to allow
requests from `https://researchpocket.github.io`:

- **Ollama:** start it with
  `OLLAMA_ORIGINS=https://researchpocket.github.io ollama serve`, then use the
  address `http://localhost:11434/v1`.
- **LM Studio:** start the local server with CORS enabled, then use
  `http://localhost:1234/v1`.
- **Other services:** run a gateway such as LiteLLM on localhost and point
  **Other local server** at it.

Your browser may ask before letting a website reach your local network; allow
it for ResearchPocket. If the connection still fails, **Test and save** explains
what it could not reach.

## Suggest tags

Open a save and choose the **Assistant** button in the Reader toolbar, then
**Suggest tags**. Suggestions that match tags already in your library are
selected for you and keep your spelling. New tags are marked **new** and start
unselected. Toggle the ones you want and choose **Add tags**. The change is an
ordinary edit, so **Undo** reverses it.

## Summarize a save

Choose **Summarize** to stream a short draft: one line with the gist, then the
key points. **Stop** ends it early. **Add to note** appends the draft to your
private note, where you can edit it like anything else you wrote. **Copy**
copies it, and **Discard** throws it away.

## What gets sent

Expand **What gets sent** in the assistant panel to see each field and its size
before you send. A request includes:

- the save's title, URL, and excerpt;
- its captured page, up to 24,000 characters in total;
- for tag suggestions, the names of up to 200 of your most-used tags.

Your private note is sent only when you tick **Include my note** for that
request. Nothing else from your library is sent. The first time you use a
provider, ResearchPocket asks you to confirm where the request is going. That
provider's own data policy applies to what it receives.

Requests go directly from your browser to the provider, or to your own
computer for a local server. ResearchPocket has no server in between.

## Change or turn off the assistant

In **Settings → Assistant**:

- **Change provider or model** reopens the setup.
- **Forget key** removes the key from this browser, including other open tabs.
- **Turn off assistant** removes the setup and the key and hides the Reader
  action.

Forgetting a key here does not revoke it with the provider; revoke it in the
provider's console if it may have been exposed.

For the design and its security boundary, see
[ADR 0015](../v2/ADR_0015_BYOK_AI_ASSISTANCE.md) and
[Data, sync, and privacy](../v2/DATA_AND_PRIVACY.md#assistant-privacy).
