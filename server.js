import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { z } from "zod";

const widgetHtml = readFileSync(
  new URL("./widget.html", import.meta.url),
  "utf8"
);

const WEATHER_CODES = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  80: "Rain showers",
  95: "Thunderstorm",
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// --- Real business logic: geocode a city, then fetch live forecast data ---
async function fetchWeatherForCity(city) {
  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      city
    )}&count=1&language=en&format=json`
  );
  if (!geoRes.ok) throw new Error(`Geocoding failed: ${geoRes.status}`);
  const geoData = await geoRes.json();
  const place = geoData?.results?.[0];
  if (!place) throw new Error(`Could not find location: ${city}`);

  const { latitude, longitude, name, country } = place;

  const forecastRes = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,wind_speed_10m,weather_code` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code` +
      `&timezone=auto&forecast_days=5`
  );
  if (!forecastRes.ok) throw new Error(`Forecast fetch failed: ${forecastRes.status}`);
  const forecastData = await forecastRes.json();

  const current = forecastData.current;
  const daily = forecastData.daily;

  const forecast = daily.time.map((dateStr, i) => ({
    day: DAY_NAMES[new Date(dateStr).getUTCDay()],
    highC: Math.round(daily.temperature_2m_max[i]),
    lowC: Math.round(daily.temperature_2m_min[i]),
    conditions: WEATHER_CODES[daily.weather_code[i]] ?? "Unknown",
  }));

  return {
    city: `${name}, ${country}`,
    currentTempC: Math.round(current.temperature_2m),
    windSpeedKmh: Math.round(current.wind_speed_10m),
    conditions: WEATHER_CODES[current.weather_code] ?? "Unknown",
    forecast,
    updatedAt: new Date().toISOString(),
  };
}

function createWeatherServer() {
  const server = new McpServer({ name: "weather-agent", version: "0.1.0" });

  server.registerResource(
    "weather-widget",
    "ui://widget/weather.html",
    {
      title: "Weather widget",
      description: "Interactive current conditions and 5-day forecast card.",
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
          uri: "ui://widget/weather.html",
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

  server.registerTool(
    "get_weather",
    {
      title: "Get weather",
      description:
        "Use this when the user asks for the current weather or forecast for a city. Fetches real, live data from the Open-Meteo public API.",
      inputSchema: { city: z.string().min(1) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        "openai/outputTemplate": "ui://widget/weather.html",
        "openai/toolInvocation/invoking": "Fetching live weather data",
        "openai/toolInvocation/invoked": "Weather data loaded",
        "openai/widgetAccessible": true,
      },
    },
    async ({ city }) => {
      try {
        const result = await fetchWeatherForCity(city);
        return {
          content: [
            {
              type: "text",
              text: `Current weather in ${result.city}: ${result.currentTempC}°C, ${result.conditions}.`,
            },
          ],
          structuredContent: result,
          _meta: {
            "openai/outputTemplate": "ui://widget/weather.html",
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Could not fetch weather: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

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
    res.writeHead(200, { "content-type": "text/plain" }).end("Weather MCP server is running");
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname.startsWith(MCP_PATH) && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    const server = createWeatherServer();
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
  console.log(`Weather MCP server listening on http://localhost:${port}${MCP_PATH}`);
});
