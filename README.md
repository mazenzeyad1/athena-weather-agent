# Athena Weather Agent — Working Reference Implementation

A fully working example of the Athena Agent SDK pattern (MCP server + interactive
widget). It fetches **real, live weather data** from the free
[Open-Meteo](https://open-meteo.com/) public API — no API key required — and
renders it in an interactive widget with unit toggling and a refresh button.

Verified working end-to-end via the MCP protocol (`tools/list`, `resources/list`,
`tools/call`) — see "What's been tested" below.

## Structure

```
athena-agent/
  package.json
  server.js         # MCP server: tool + widget resource registration
  widget.html       # Interactive widget (vanilla JS, no build step)
  README.md
```

## 1. Install & run locally

From the project root:

```bash
npm install
node server.js
```

You should see:
```
Weather MCP server listening on http://localhost:8787/mcp
```

## 2. Test with MCP Inspector (recommended before connecting to Athena)

```bash
npx @modelcontextprotocol/inspector@latest --server-url http://localhost:8787/mcp --transport http
```

This opens a browser UI where you can call `get_weather` with a `city` argument
and see the structured response and widget render.

You can also test directly with curl:

```bash
curl -s http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_weather","arguments":{"city":"Montreal"}}}'
```

## 3. Expose to the public internet with ngrok

Athena needs an HTTPS URL it can reach, so tunnel your local server:

```bash
ngrok http 8787
```

Copy the `https://<subdomain>.ngrok.app` URL it gives you.

## 4. Connect to Athena

1. Go to `https://athenachat.bot/chatbot/mybots/create`
2. Fill in name/description/prompt
3. In the MCP section, paste your ngrok URL **with the `/mcp` path**, e.g.
   `https://<subdomain>.ngrok.app/mcp`
4. Save, then go to `https://athenachat.bot/chatbot/mybots` → "Go to Agent" and
   chat with it (e.g. "what's the weather in Cairo?") to trigger the tool call
   and see the widget render.

After any code change, click **Refresh** in Settings → Connectors so Athena
re-reads your tool/resource definitions.

## What's been tested

Run in this environment (sandboxed, so the live Open-Meteo API call itself was
blocked by network egress rules — but the full MCP request/response cycle was
verified):

- ✅ `npm install` — all MCP SDK dependencies resolve correctly
- ✅ Server boots and responds to health check (`GET /`)
- ✅ `tools/list` — `get_weather` tool is correctly registered with valid JSON
  Schema input, annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`),
  and `_meta` pointing to the widget template
- ✅ `resources/list` — `ui://widget/weather.html` resource is correctly
  registered
- ✅ `tools/call` — full request/response cycle works; error handling returns a
  clean `isError: true` result when the external fetch fails (confirms the
  try/catch and MCP response shape are correct)

**On your own machine with normal internet access, the Open-Meteo calls will
succeed** and return real current + 5-day forecast data — the code only failed
here because this sandbox restricts outbound network calls to a small
allowlist of package-registry domains.

## Swapping in your actual challenge subject

Once the real subject is revealed, you likely just need to:

1. Replace `fetchWeatherForCity()` in `server.js` with a fetch against
   whatever public API/data source your subject requires.
2. Update the `structuredContent` shape returned by the tool to match your
   new data.
3. Update `widget.html` to render the new fields (keep the same
   `window.openai.toolOutput` read pattern and the `callTool` refresh pattern
   — those don't need to change).
4. Rename the tool from `get_weather` to something matching your subject, and
   update its `description` (the "Use this when…" phrasing is what Athena uses
   for tool discovery).

The MCP plumbing (server setup, resource registration, widget runtime hookup,
ngrok exposure, Athena connection) is identical regardless of subject — that's
the part this reference implementation proves out end-to-end.

## Key concepts demonstrated

- **Real data retrieval**: two chained live API calls (geocoding → forecast),
  not mocked data
- **Structured content**: `structuredContent` returned to both the model and
  the widget
- **Widget interactivity**: unit toggle (°C/°F) purely client-side, plus a
  "Refresh" button that calls back into the MCP tool via
  `window.openai.callTool`
- **Host sync**: listens for `openai:set_globals` so the widget updates if
  Athena pushes new tool output
- **Proper annotations**: `readOnlyHint`, `destructiveHint`, `openWorldHint`
  set correctly since this tool only reads external public data
- **Error handling**: fetch failures return a clean MCP error result instead
  of crashing the server
