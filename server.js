require("dotenv").config();

const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const CHECK_INTERVAL_MIN = Number(process.env.ALERT_CHECK_INTERVAL_MIN || 15);
const ALERT_COOLDOWN_MIN = Number(process.env.ALERT_COOLDOWN_MIN || 360);
const SUBS_FILE = path.join(__dirname, "data", "subscriptions.json");
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 8000);
const AQI_CACHE_TTL_MS = Number(process.env.AQI_CACHE_TTL_MS || 600000);
const CITY_SEARCH_CACHE_TTL_MS = Number(process.env.CITY_SEARCH_CACHE_TTL_MS || 300000);
// Edit this block to control dashboard data without adding any frontend controls.
const DASHBOARD_DATA_CONTROL = {
  mode: "live",
  mockPreset: "mixed",
  mockIntensity: 100,
};
const WAQI_TOKEN = String(process.env.WAQI_TOKEN || "").trim();

const lastAlertAt = new Map();
const aqiCache = new Map();
const citySearchCache = new Map();
const mockPresets = {
  clean: { base: 38, spread: 18 },
  mixed: { base: 94, spread: 42 },
  smog: { base: 188, spread: 60 },
  emergency: { base: 302, spread: 90 },
};
const fallbackAqiByCity = new Map(
  [
    {
      city: "Delhi",
      region: "NCR",
      country: "India",
      coordinates: { latitude: 28.65195, longitude: 77.23149 },
      observedAt: null,
      aqi: 312,
      category: "Hazardous",
      pollutants: { pm25: 198, pm10: 285, co: 2.1, no2: 62, ozone: 18 },
    },
    {
      city: "Mumbai",
      region: "Maharashtra",
      country: "India",
      coordinates: { latitude: 19.076, longitude: 72.8777 },
      observedAt: null,
      aqi: 142,
      category: "Unhealthy",
      pollutants: { pm25: 78, pm10: 130, co: 1.4, no2: 40, ozone: 32 },
    },
    {
      city: "Bengaluru",
      region: "Karnataka",
      country: "India",
      coordinates: { latitude: 12.97623, longitude: 77.60329 },
      observedAt: null,
      aqi: 72,
      category: "Moderate",
      pollutants: { pm25: 30, pm10: 58, co: 0.9, no2: 22, ozone: 44 },
    },
    {
      city: "Kolkata",
      region: "West Bengal",
      country: "India",
      coordinates: { latitude: 22.56263, longitude: 88.36304 },
      observedAt: null,
      aqi: 178,
      category: "Unhealthy",
      pollutants: { pm25: 102, pm10: 160, co: 1.7, no2: 48, ozone: 22 },
    },
    {
      city: "Chennai",
      region: "Tamil Nadu",
      country: "India",
      coordinates: { latitude: 13.08784, longitude: 80.27847 },
      observedAt: null,
      aqi: 95,
      category: "Moderate",
      pollutants: { pm25: 48, pm10: 82, co: 1.0, no2: 28, ozone: 38 },
    },
  ].map((item) => [item.city.toLowerCase(), item])
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function toTitleCase(input) {
  return input
    .trim()
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function nowIso() {
  return new Date().toISOString();
}

function aqiCategory(aqi) {
  if (aqi == null) return "Unknown";
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

async function readSubscriptions() {
  try {
    const raw = await fs.readFile(SUBS_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeSubscriptions(subscriptions) {
  await fs.writeFile(SUBS_FILE, JSON.stringify(subscriptions, null, 2), "utf8");
}

function findLatestHourlyValue(timestamps, values) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (value != null) {
      return { time: timestamps[i], value };
    }
  }
  return { time: null, value: null };
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cityHash(input) {
  return String(input || "")
    .toLowerCase()
    .split("")
    .reduce((sum, char, index) => sum + char.charCodeAt(0) * (index + 1), 0);
}

function getFreshCache(cache, key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > ttlMs) return null;
  return entry.value;
}

function setCache(cache, key, value) {
  cache.set(key, { value, savedAt: Date.now() });
}

async function fetchJson(url, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

function fallbackCityAqi(city) {
  const normalized = String(city || "").trim().toLowerCase();
  const fallback = fallbackAqiByCity.get(normalized);
  if (!fallback) return null;
  return { ...fallback, source: "fallback" };
}

function mockCityAqi(city) {
  const normalized = String(city || "").trim();
  const fallback = fallbackCityAqi(normalized);
  const preset = mockPresets[DASHBOARD_DATA_CONTROL.mockPreset] || mockPresets.mixed;
  const intensity = clampNumber(Number(DASHBOARD_DATA_CONTROL.mockIntensity) || 100, 50, 200);
  const seed = cityHash(normalized);
  const scale = intensity / 100;
  const offset = (seed % 5) * preset.spread - Math.floor(seed % 3) * 8;
  const aqi = clampNumber(Math.round((preset.base + offset) * scale), 18, 500);
  const category = aqiCategory(aqi);

  return {
    city: fallback?.city || toTitleCase(normalized),
    region: fallback?.region || "Mock Region",
    country: fallback?.country || "Mock Country",
    coordinates: fallback?.coordinates || { latitude: null, longitude: null },
    observedAt: nowIso(),
    aqi,
    category,
    pollutants: {
      pm25: clampNumber(Math.round(aqi * 0.63), 10, 420),
      pm10: clampNumber(Math.round(aqi * 0.91), 18, 500),
      co: clampNumber(Number((aqi / 110).toFixed(1)), 0.4, 5.5),
      no2: clampNumber(Math.round(aqi * 0.18), 6, 140),
      ozone: clampNumber(Math.round(aqi * 0.22), 8, 120),
    },
    source: "mock",
  };
}

async function fetchDashboardCityAqi(city) {
  const cacheKey = String(city || "").trim().toLowerCase();

  if (DASHBOARD_DATA_CONTROL.mode === "mock") {
    return mockCityAqi(city);
  }

  if (DASHBOARD_DATA_CONTROL.mode === "fallback") {
    const fallback = fallbackCityAqi(city);
    if (fallback) return fallback;
    throw new Error("No fallback data configured for this city");
  }

  try {
    const live = await fetchCityAqi(city);
    setCache(aqiCache, cacheKey, live);
    return live;
  } catch (error) {
    const cached = getFreshCache(aqiCache, cacheKey, AQI_CACHE_TTL_MS);
    if (cached) return cached;
    const fallback = fallbackCityAqi(city);
    if (fallback) return fallback;
    throw error;
  }
}

function parseWaqiCityName(rawName, fallbackCity) {
  const text = String(rawName || "").trim();
  if (!text) {
    return {
      city: toTitleCase(fallbackCity),
      region: null,
      country: null,
    };
  }

  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  return {
    city: parts[0] || toTitleCase(fallbackCity),
    region: parts[1] || null,
    country: parts[parts.length - 1] || null,
  };
}

async function geocodeCity(city) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", city);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const data = await fetchJson(url.toString());
  if (!data.results || data.results.length === 0) {
    throw new Error("City not found");
  }

  const top = data.results[0];
  return {
    name: top.name,
    country: top.country,
    admin1: top.admin1,
    latitude: top.latitude,
    longitude: top.longitude,
    timezone: top.timezone,
  };
}

async function searchIndianCities(query, limit = 6) {
  const cacheKey = `${String(query || "").trim().toLowerCase()}|${limit}`;
  const cached = getFreshCache(citySearchCache, cacheKey, CITY_SEARCH_CACHE_TTL_MS);
  if (cached) return cached;

  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", String(limit));
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  url.searchParams.set("countryCode", "IN");

  const data = await fetchJson(url.toString());
  if (!Array.isArray(data.results)) return [];

  const results = data.results.map((item) => ({
    city: item.name,
    region: item.admin1 || item.admin2 || "India",
    country: item.country || "India",
    latitude: item.latitude,
    longitude: item.longitude,
  }));
  setCache(citySearchCache, cacheKey, results);
  return results;
}

async function fetchAqiByCoordinates(latitude, longitude, timezone = "auto") {
  const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("timezone", timezone);
  url.searchParams.set(
    "hourly",
    "us_aqi,pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,ozone"
  );

  const data = await fetchJson(url.toString());
  const hourly = data.hourly;
  if (!hourly || !hourly.time) {
    throw new Error("Air quality data unavailable");
  }

  const aqiPoint = findLatestHourlyValue(hourly.time, hourly.us_aqi || []);
  const pm25 = findLatestHourlyValue(hourly.time, hourly.pm2_5 || []);
  const pm10 = findLatestHourlyValue(hourly.time, hourly.pm10 || []);
  const co = findLatestHourlyValue(hourly.time, hourly.carbon_monoxide || []);
  const no2 = findLatestHourlyValue(hourly.time, hourly.nitrogen_dioxide || []);
  const ozone = findLatestHourlyValue(hourly.time, hourly.ozone || []);

  return {
    observedAt: aqiPoint.time || pm25.time,
    aqi: aqiPoint.value != null ? Math.round(aqiPoint.value) : null,
    category: aqiCategory(aqiPoint.value),
    pollutants: {
      pm25: pm25.value,
      pm10: pm10.value,
      co: co.value,
      no2: no2.value,
      ozone: ozone.value,
    },
  };
}

async function fetchCityAqi(city) {
  if (!WAQI_TOKEN) {
    throw new Error("WAQI_TOKEN is missing");
  }

  const location = await geocodeCity(city);
  const geoUrl = new URL(
    `https://api.waqi.info/feed/geo:${location.latitude};${location.longitude}/`
  );
  geoUrl.searchParams.set("token", WAQI_TOKEN);

  let payload = await fetchJson(geoUrl.toString());

  if (payload.status !== "ok" || !payload.data) {
    const cityUrl = new URL(`https://api.waqi.info/feed/${encodeURIComponent(city)}/`);
    cityUrl.searchParams.set("token", WAQI_TOKEN);
    payload = await fetchJson(cityUrl.toString());
  }

  if (payload.status !== "ok" || !payload.data) {
    throw new Error(payload.data || "WAQI feed unavailable");
  }

  const feed = payload.data;
  const parsedName = parseWaqiCityName(feed.city?.name, location.name || city);

  return {
    city: parsedName.city || location.name,
    region: parsedName.region || location.admin1 || null,
    country: parsedName.country || location.country || null,
    coordinates: {
      latitude: Array.isArray(feed.city?.geo) ? feed.city.geo[0] : location.latitude,
      longitude: Array.isArray(feed.city?.geo) ? feed.city.geo[1] : location.longitude,
    },
    observedAt: feed.time?.iso || null,
    aqi: Number.isFinite(Number(feed.aqi)) ? Number(feed.aqi) : null,
    category: aqiCategory(Number(feed.aqi)),
    pollutants: {
      pm25: feed.iaqi?.pm25?.v ?? null,
      pm10: feed.iaqi?.pm10?.v ?? null,
      co: feed.iaqi?.co?.v ?? null,
      no2: feed.iaqi?.no2?.v ?? null,
      ozone: feed.iaqi?.o3?.v ?? null,
    },
    source: "waqi",
  };
}

async function fetchCityAqiWithFallback(city) {
  try {
    return await fetchCityAqi(city);
  } catch (_error) {
    const fallback = fallbackCityAqi(city);
    if (fallback) return fallback;
    return null;
  }
}

async function sendSmsTwilio({ to, body }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_FROM_PHONE;

  if (!accountSid || !authToken || !fromPhone) {
    console.log(`[SMS Fallback] to=${to} body=${body}`);
    return { sent: false, fallback: true };
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const payload = new URLSearchParams({
    To: to,
    From: fromPhone,
    Body: body,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: payload.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio error ${response.status}: ${text}`);
  }

  return { sent: true, fallback: false };
}

function validPhone(phone) {
  return /^\+?[1-9]\d{7,14}$/.test(phone.trim());
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, now: nowIso() });
});

app.get("/api/aqi", async (req, res) => {
  try {
    const cityParam = String(req.query.city || "").trim();
    if (!cityParam) {
      return res.status(400).json({ error: "city query parameter is required" });
    }

    const data = await fetchDashboardCityAqi(cityParam);
    return res.json(data);
  } catch (error) {
    const fallback = fallbackCityAqi(req.query.city);
    if (fallback) {
      return res.json(fallback);
    }
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
});

app.get("/api/cities", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 10);

    if (query.length < 2) {
      return res.json([]);
    }

    const cities = await searchIndianCities(query, limit);
    return res.json(cities);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to search cities" });
  }
});

app.get("/api/subscriptions", async (_req, res) => {
  try {
    const subscriptions = await readSubscriptions();
    res.json(subscriptions);
  } catch (error) {
    res.status(500).json({ error: error.message || "Unable to read subscriptions" });
  }
});

app.post("/api/subscribe", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const phone = String(req.body.phone || "").trim();
    const city = String(req.body.city || "").trim();
    const threshold = Number(req.body.threshold || 100);

    if (!name || !phone || !city) {
      return res.status(400).json({ error: "name, phone, and city are required" });
    }

    if (!validPhone(phone)) {
      return res
        .status(400)
        .json({ error: "phone must be in valid E.164-like format" });
    }

    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 500) {
      return res.status(400).json({ error: "threshold must be between 0 and 500" });
    }

    const normalized = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: toTitleCase(name),
      phone,
      city: toTitleCase(city),
      threshold: Math.round(threshold),
      createdAt: nowIso(),
      lastNotifiedAt: null,
    };

    const subscriptions = await readSubscriptions();
    const duplicate = subscriptions.find(
      (s) => s.phone === normalized.phone && s.city.toLowerCase() === normalized.city.toLowerCase()
    );

    if (duplicate) {
      return res
        .status(409)
        .json({ error: "subscription already exists for this phone and city" });
    }

    subscriptions.push(normalized);
    await writeSubscriptions(subscriptions);

    return res.status(201).json(normalized);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
});

async function runAlertWorker() {
  const subscriptions = await readSubscriptions();
  if (subscriptions.length === 0) return;

  const cityCache = new Map();
  const cooldownMs = ALERT_COOLDOWN_MIN * 60 * 1000;

  for (const subscription of subscriptions) {
    const key = `${subscription.phone}|${subscription.city.toLowerCase()}`;
    const last = lastAlertAt.get(key);

    if (last && Date.now() - last < cooldownMs) {
      continue;
    }

    let cityData = cityCache.get(subscription.city.toLowerCase());
    if (!cityData) {
      cityData = await fetchCityAqiWithFallback(subscription.city);
      if (!cityData) {
        console.error(`Alert worker failed city fetch (${subscription.city}): no live/fallback data`);
        continue;
      }
      cityCache.set(subscription.city.toLowerCase(), cityData);
    }

    if (cityData.aqi == null || cityData.aqi < subscription.threshold) {
      continue;
    }

    const body = `AQI Alert: ${cityData.city} is ${cityData.aqi} (${cityData.category}). Threshold ${subscription.threshold} crossed.`;

    try {
      await sendSmsTwilio({ to: subscription.phone, body });
      lastAlertAt.set(key, Date.now());
      subscription.lastNotifiedAt = nowIso();
      console.log(`Alert sent to ${subscription.phone} for ${subscription.city}`);
    } catch (error) {
      console.error(`SMS send failed to ${subscription.phone}: ${error.message}`);
    }
  }

  await writeSubscriptions(subscriptions);
}

setInterval(() => {
  runAlertWorker().catch((error) => {
    console.error(`Alert worker tick failed: ${error.message}`);
  });
}, CHECK_INTERVAL_MIN * 60 * 1000);

runAlertWorker().catch((error) => {
  console.error(`Initial alert worker run failed: ${error.message}`);
});

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`Air Quality app listening on http://localhost:${port}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      const fallbackPort = port + 1;
      console.warn(`Port ${port} is in use. Retrying on ${fallbackPort}...`);
      startServer(fallbackPort);
      return;
    }
    throw error;
  });
}

startServer(PORT);
