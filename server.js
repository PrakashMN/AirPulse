require("dotenv").config();

const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const CHECK_INTERVAL_MIN = Number(process.env.ALERT_CHECK_INTERVAL_MIN || 15);
const ALERT_COOLDOWN_MIN = Number(process.env.ALERT_COOLDOWN_MIN || 360);
const SUBS_FILE = path.join(__dirname, "data", "subscriptions.json");

const lastAlertAt = new Map();

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

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
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
  const location = await geocodeCity(city);
  const aqi = await fetchAqiByCoordinates(
    location.latitude,
    location.longitude,
    location.timezone || "auto"
  );

  return {
    city: location.name,
    region: location.admin1 || null,
    country: location.country,
    coordinates: {
      latitude: location.latitude,
      longitude: location.longitude,
    },
    ...aqi,
  };
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

    const data = await fetchCityAqi(cityParam);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
});

app.get("/api/subscriptions", async (_req, res) => {
  const subscriptions = await readSubscriptions();
  res.json(subscriptions);
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
      try {
        cityData = await fetchCityAqi(subscription.city);
        cityCache.set(subscription.city.toLowerCase(), cityData);
      } catch (error) {
        console.error(`Alert worker failed city fetch (${subscription.city}): ${error.message}`);
        continue;
      }
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

app.listen(PORT, () => {
  console.log(`Air Quality app listening on http://localhost:${PORT}`);
});
