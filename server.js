import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { z } from "zod";

// Load the embedded HTML widget so the MCP resource can return a self-contained
// UI that Athena can render inline in the chat experience.
const widgetHtml = readFileSync(
  new URL("./widget.html", import.meta.url),
  "utf8"
);

// Time windows used by the public USGS API when a user asks for recent quakes.
const PERIOD_MS = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

const SEARCH_RADIUS_KM = 1500;
const MAX_EVENTS = 20;
const FETCH_TIMEOUT_MS = 8000;

// Geocoding answers are stable enough to cache per process so repeated lookups
// for the same region do not trigger extra network requests.
const geocodeCache = new Map();

// The geocoder does not know about Türkiye as a country entry, so redirect those
// aliases to the capital city for a reliable coordinate match.
const REGION_ALIASES = {
  turkey: "Ankara",
  türkiye: "Ankara",
  turkiye: "Ankara",
};

// Prefer a country, then a capital, then an admin centre, over a tiny hamlet
// that happens to share the name (e.g. "Turkey", North Carolina).
function placeRank(featureCode = "") {
  if (featureCode.startsWith("PCL")) return 0;
  if (featureCode === "PPLC") return 1;
  if (featureCode.startsWith("PPLA") || featureCode.startsWith("ADM")) return 2;
  return 3;
}

// Upstream APIs occasionally blip; fail fast and retry once rather than hanging.
async function fetchWithRetry(url, label) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`${label} returned ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (err.name === "TimeoutError") lastError = new Error(`${label} timed out`);
    }
  }
  throw lastError;
}

// Resolve a place name to coordinates so we can search a region, not just the globe.
async function geocodeRegion(region) {
  const key = region.trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const query = REGION_ALIASES[key] ?? region;
  const data = await fetchWithRetry(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      query
    )}&count=10&language=en&format=json`,
    "Geocoding"
  );

  // Rank candidates so a country beats a same-named village, then prefer the
  // most populated match within the same tier.
  const place = (data?.results ?? [])
    .slice()
    .sort(
      (a, b) =>
        placeRank(a.feature_code) - placeRank(b.feature_code) ||
        (b.population ?? 0) - (a.population ?? 0)
    )[0];
  if (!place) throw new Error(`Could not find region: ${region}`);

  const parts = [place.name, place.country].filter(Boolean);
  const resolved = {
    label: [...new Set(parts)].join(", "),
    latitude: place.latitude,
    longitude: place.longitude,
  };
  geocodeCache.set(key, resolved);
  return resolved;
}

// --- Real business logic: live seismic events from the USGS FDSN event API ---
async function fetchEarthquakes({ region, minMagnitude, period }) {
  const windowMs = PERIOD_MS[period] ?? PERIOD_MS.day;
  const startTime = new Date(Date.now() - windowMs).toISOString();

  const params = new URLSearchParams({
    format: "geojson",
    starttime: startTime,
    minmagnitude: String(minMagnitude),
    orderby: "time",
    limit: String(MAX_EVENTS),
  });

  let regionLabel = "Worldwide";
  let center = null;

  if (region) {
    const place = await geocodeRegion(region);
    regionLabel = place.label;
    center = { latitude: place.latitude, longitude: place.longitude };
    params.set("latitude", String(place.latitude));
    params.set("longitude", String(place.longitude));
    params.set("maxradiuskm", String(SEARCH_RADIUS_KM));
  }

  const data = await fetchWithRetry(
    `https://earthquake.usgs.gov/fdsnws/event/1/query?${params.toString()}`,
    "USGS catalog"
  );

  const quakes = (data.features ?? []).map((feature) => {
    const [lon, lat, depth] = feature.geometry?.coordinates ?? [];
    return {
      id: feature.id,
      magnitude: Math.round((feature.properties.mag ?? 0) * 10) / 10,
      place: feature.properties.place ?? "Unknown location",
      time: new Date(feature.properties.time).toISOString(),
      depthKm: Math.round((depth ?? 0) * 10) / 10,
      lat: Math.round((lat ?? 0) * 100) / 100,
      lon: Math.round((lon ?? 0) * 100) / 100,
      tsunami: Boolean(feature.properties.tsunami),
      url: feature.properties.url ?? "",
    };
  });

  const magnitudes = quakes.map((q) => q.magnitude);

  return {
    region: regionLabel,
    query: region ?? null,
    center,
    radiusKm: region ? SEARCH_RADIUS_KM : null,
    period,
    minMagnitude,
    count: quakes.length,
    maxMagnitude: magnitudes.length ? Math.max(...magnitudes) : 0,
    strongest: quakes.length
      ? quakes.reduce((a, b) => (b.magnitude > a.magnitude ? b : a)).place
      : null,
    quakes,
    updatedAt: new Date().toISOString(),
  };
}

function createEarthquakeServer() {
  // Build a fresh MCP server instance for each request so the service stays
  // stateless and easy to restart or redeploy without background state leaks.
  const server = new McpServer({ name: "earthquake-explorer", version: "1.0.0" });

  // Register the widget resource that Athena discovers for inline UI rendering.
  server.registerResource(
    "earthquake-widget",
    "ui://widget/earthquakes.html",
    {
      title: "Earthquake activity explorer",
      description: "Interactive list of recent seismic events with filters and sorting.",
      mimeType: "text/html+skybridge",
      _meta: {
        "openai/widgetPrefersBorder": true,
        "openai/widgetCSP": {
          connect_domains: [],
          resource_domains: [],
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: "ui://widget/earthquakes.html",
          mimeType: "text/html+skybridge",
          text: widgetHtml,
          _meta: {
            "openai/widgetPrefersBorder": true,
            "openai/widgetCSP": {
              connect_domains: [],
              resource_domains: [],
            },
          },
        },
      ],
    })
  );

  // Register the main tool that the agent calls when a user asks about seismic
  // activity. It returns a short text summary plus structured event data.
  server.registerTool(
    "explore_earthquakes",
    {
      title: "Explore earthquake activity",
      description:
        "Use this when the user asks about earthquakes, seismic activity, tremors, or recent quakes — worldwide or near a specific place. Fetches real, live event data from the USGS earthquake catalog.",
      inputSchema: {
        region: z
          .string()
          .optional()
          .describe(
            "Optional place name to search around (e.g. 'Japan', 'California', 'Istanbul'). Omit for worldwide activity."
          ),
        minMagnitude: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe("Minimum magnitude to include. Defaults to 4.5."),
        period: z
          .enum(["hour", "day", "week", "month"])
          .optional()
          .describe("How far back to search. Defaults to 'day'."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        "openai/outputTemplate": "ui://widget/earthquakes.html",
        "openai/toolInvocation/invoking": "Querying live seismic data",
        "openai/toolInvocation/invoked": "Earthquake data loaded",
        "openai/widgetAccessible": true,
      },
    },
    async ({ region, minMagnitude = 4.5, period = "day" }) => {
      try {
        const result = await fetchEarthquakes({ region, minMagnitude, period });

        const summary = result.count
          ? `Found ${result.count} earthquake${result.count === 1 ? "" : "s"} of M${result.minMagnitude}+ ` +
            `in the past ${result.period} (${result.region}). Strongest: M${result.maxMagnitude} near ${result.strongest}.`
          : `No earthquakes of M${result.minMagnitude}+ recorded in the past ${result.period} (${result.region}).`;

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: result,
          _meta: {
            "openai/outputTemplate": "ui://widget/earthquakes.html",
          },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Could not fetch earthquake data: ${err.message}` },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

// Run a lightweight HTTP server that exposes the MCP endpoint over a normal web
// port. This keeps the project deployable as a simple Render service without a
// custom adapter layer.
const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname.startsWith(MCP_PATH)) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "text/plain" })
      .end("Earthquake Explorer MCP server is running");
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname.startsWith(MCP_PATH) && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    const server = createEarthquakeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`Earthquake Explorer MCP server listening on http://localhost:${port}${MCP_PATH}`);
});
