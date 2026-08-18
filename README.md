# Earthquake Activity Explorer — Athena Agent

An Athena AI Agent (MCP server + interactive widget) that retrieves **real, live
seismic data** from the [USGS earthquake catalog](https://earthquake.usgs.gov/fdsnws/event/1/)
— a free public API with no key required — and renders it as an interactive
widget embedded directly in the Athena chat.

**Live MCP endpoint:** `https://athena-weather-agent.onrender.com/mcp`

## Project notes

This project is a small MCP server that exposes a single live data tool and a UI
widget. The server fetches public seismic data from the USGS and Open-Meteo APIs,
then returns both a machine-readable payload and a skybridge HTML widget for Athena
to render directly in the chat.

The main idea is simple:
- the server exposes `explore_earthquakes`
- the tool resolves the region to coordinates
- the app queries the USGS earthquake feed for recent events
- the widget renders the event list with filters, sorting, and refresh behavior

## What it does

The `explore_earthquakes` tool queries live seismic events and returns both a
text summary for the model and structured data for the widget.

| Input | Type | Default | Notes |
|---|---|---|---|
| `region` | string, optional | worldwide | Place name — geocoded, then searched within a 1500 km radius |
| `minMagnitude` | number, optional | `4.5` | Lower bound on magnitude |
| `period` | `hour` \| `day` \| `week` \| `month` | `day` | How far back to search |

Two chained live API calls: Open-Meteo geocoding (place name → coordinates),
then USGS FDSN event query (coordinates → seismic events).

Example prompts:
- "Any earthquakes today?"
- "Show me seismic activity near Japan this month above magnitude 5"
- "Recent quakes in California"

## Widget interactivity

- **Magnitude filter chips** — All / M5+ / M6+, filters client-side instantly
- **Sort toggle** — switch between Latest and Strongest
- **Expandable rows** — tap any event for exact time, depth, and coordinates
- **Show all / fewer** — progressive disclosure for long result sets
- **Refresh** — calls back into the MCP tool via `window.openai.callTool` for fresh data

Magnitude badges are colour-coded by severity, and tsunami-flagged events are
marked.

## Architecture

```
server.js       # MCP server: tool + widget resource registration, USGS/geocoding fetches
widget.html     # Self-contained interactive widget (vanilla JS, no build step)
package.json
```

The server is stateless — a fresh `McpServer` and transport are created per
request — so it scales and restarts cleanly.

## Run locally

```bash
npm install
node server.js
```

Then point the MCP Inspector at it:

```bash
npx @modelcontextprotocol/inspector@latest --server-url http://localhost:8787/mcp --transport http
```

Or call it directly:

```bash
curl -s http://localhost:8787/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"explore_earthquakes","arguments":{"region":"Japan","period":"month"}}}'
```

## Quick start

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the server locally:
   ```bash
   node server.js
   ```
3. Test the endpoint:
   ```bash
   curl -s http://localhost:8787/ 
   ```
4. Query the MCP tool directly:
   ```bash
   curl -s http://localhost:8787/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"explore_earthquakes","arguments":{"region":"Japan","period":"month"}}}'
   ```

## Deployment

Deployed on Render as a web service (build `npm install`, start `npm start`),
which gives a permanent HTTPS URL — no ngrok tunnel required, so the agent keeps
working after the dev machine is off.

## Troubleshooting

- If the server does not respond on localhost, confirm that port `8787` is free and
  that `node server.js` started without errors.
- If a region returns no results, try a broader name such as `Japan`, `California`,
  or `Turkey` instead of a very small locality.
- If Athena does not render the widget, re-add the MCP connector after changing the
  server metadata so Athena refreshes `tools/list` and `resources/list`.
- If the widget appears as plain text, verify that the resource registration includes
  `mimeType: "text/html+skybridge"` and that the tool sets the output template to
  the widget resource URI.

## Connecting to Athena

1. Go to `https://athenachat.bot/chatbot/mybots/create` → Chat Agent → Start blank
2. Fill in name, description, and prompt
3. Under **Capabilities → MCP**, set the MCP Server URL (with the `/mcp` path) and
   leave authorization as **No Auth**
4. Create the agent and chat with it

**Important:** Athena caches tool and resource discovery at the moment the
connector is added. After changing tool or resource metadata on the server,
re-add the connector (or create a fresh agent) so Athena re-reads
`tools/list` and `resources/list`.

## Widget rendering requirements

For Athena to render the widget instead of falling back to plain text, all of
the following must hold:

1. The widget resource is registered with `mimeType: "text/html+skybridge"` **in
   the registration config**, so it appears in `resources/list` — not only in
   the body of `resources/read`. Athena discovers widgets by scanning that
   listing.
2. The tool descriptor sets `_meta["openai/outputTemplate"]` to the resource URI.
3. `resources/read` returns the HTML with the same skybridge mimetype.
4. The server handles nested `/mcp/*` paths and CORS preflight.

Point 1 is the easy one to miss: passing `{}` as the `registerResource` config
produces a listing entry with only `uri` and `name`, and the widget silently
never renders.
