const { readSubscriptions, writeSubscriptions, toTitleCase } = require("./db");

const API_BASE = String(process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
const POLL_TIMEOUT_MS = 35000;
const ENABLE_POLLING = String(process.env.TELEGRAM_BOT_POLLING || "true").toLowerCase() !== "false";

let botToken = "";
let polling = false;

function setToken(token) {
  botToken = String(token || "").trim();
}

function apiUrl(method) {
  return `${API_BASE}/bot${botToken}/${method}`;
}

function describeFetchError(error) {
  const cause = error?.cause;
  const parts = [error?.message || "Unknown fetch error"];

  if (cause?.code) {
    parts.push(`code=${cause.code}`);
  }

  if (cause?.message) {
    parts.push(`cause=${cause.message}`);
  }

  return parts.join(" | ");
}

async function readResponseBody(res) {
  const text = await res.text();

  try {
    return { json: JSON.parse(text), text };
  } catch (_error) {
    return { json: null, text };
  }
}

async function apiCall(method, body) {
  let res;

  try {
    res = await fetch(apiUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Telegram request failed: ${describeFetchError(error)}`);
  }

  const { json, text } = await readResponseBody(res);

  if (!json) {
    throw new Error(`Telegram API returned non-JSON response (${res.status}): ${text.slice(0, 180)}`);
  }

  if (!res.ok || !json.ok) {
    throw new Error(`Telegram API error (${res.status}): ${json.description || text.slice(0, 180)}`);
  }

  return json.result;
}

async function sendMessage(chatId, text) {
  return apiCall("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
}

function parseCommand(text) {
  if (!text) return null;
  const match = text.match(/^\/(\w+)(.*)/s);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: match[2].trim() };
}

async function handleStart(chatId) {
  await sendMessage(
    chatId,
    "*Welcome to AirPulse!* \ud83c\udf2c\ufe0f\n\n" +
      "Get real-time Air Quality alerts via Telegram.\n\n" +
      "*Commands:*\n" +
      "/subscribe `Delhi 150` - Subscribe to AQI alerts\n" +
      "/unsubscribe `Delhi` - Stop alerts for a city\n" +
      "/list - Show your active subscriptions\n" +
      "/help - Show this message"
  );
}

async function handleHelp(chatId) {
  await handleStart(chatId);
}

async function handleSubscribe(chatId, args) {
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    return sendMessage(chatId, "Usage: `/subscribe <city> <threshold>`\nExample: `/subscribe Delhi 150`");
  }

  const threshold = parseInt(parts[parts.length - 1], 10);
  if (Number.isNaN(threshold) || threshold < 0 || threshold > 500) {
    return sendMessage(chatId, "Threshold must be a number between 0 and 500.");
  }

  const city = parts.slice(0, -1).join(" ");
  const subs = await readSubscriptions();
  const normalizedCity = toTitleCase(city);

  const existing = subs.find(
    (s) => s.telegramChatId === chatId && s.city.toLowerCase() === normalizedCity.toLowerCase()
  );

  if (existing) {
    return sendMessage(
      chatId,
      `You already have a subscription for *${normalizedCity}* (threshold: ${existing.threshold}).`
    );
  }

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    telegramChatId: chatId,
    name: `Telegram:${chatId}`,
    phone: "",
    city: normalizedCity,
    threshold: Math.round(threshold),
    createdAt: new Date().toISOString(),
    lastNotifiedAt: null,
  };

  subs.push(entry);
  await writeSubscriptions(subs);
  await sendMessage(
    chatId,
    `*Subscribed!* \u2705\n\nCity: *${normalizedCity}*\nThreshold: *${threshold}*\n\nYou will receive an alert when AQI exceeds ${threshold}.`
  );
}

async function handleUnsubscribe(chatId, args) {
  if (!args) {
    return sendMessage(chatId, "Usage: `/unsubscribe <city>`\nExample: `/unsubscribe Delhi`");
  }

  const city = toTitleCase(args);
  const subs = await readSubscriptions();
  const index = subs.findIndex(
    (s) => s.telegramChatId === chatId && s.city.toLowerCase() === city.toLowerCase()
  );

  if (index === -1) {
    return sendMessage(chatId, `No subscription found for *${city}*.`);
  }

  subs.splice(index, 1);
  await writeSubscriptions(subs);
  await sendMessage(chatId, `Unsubscribed from *${city}*. \u274c`);
}

async function handleList(chatId) {
  const subs = await readSubscriptions();
  const mine = subs.filter((s) => s.telegramChatId === chatId);

  if (mine.length === 0) {
    return sendMessage(chatId, "No active subscriptions. Use `/subscribe <city> <threshold>` to get started.");
  }

  const lines = mine.map((s) => `- *${s.city}* (threshold: ${s.threshold})`);
  await sendMessage(chatId, `*Your Subscriptions:*\n\n${lines.join("\n")}`);
}

async function processUpdate(update) {
  if (!update.message || !update.message.text) return;
  const chatId = update.message.chat.id;
  const parsed = parseCommand(update.message.text);
  if (!parsed) return;

  switch (parsed.command) {
    case "start":
      await handleStart(chatId);
      break;
    case "help":
      await handleHelp(chatId);
      break;
    case "subscribe":
      await handleSubscribe(chatId, parsed.args);
      break;
    case "unsubscribe":
      await handleUnsubscribe(chatId, parsed.args);
      break;
    case "list":
      await handleList(chatId);
      break;
    default:
      break;
  }
}

let offset = 0;

async function poll() {
  if (!botToken || polling) return;
  polling = true;
  let failCount = 0;

  while (true) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
      const url = `${API_BASE}/bot${botToken}/getUpdates?timeout=25&offset=${offset}`;

      let res;
      try {
        res = await fetch(url, { signal: controller.signal });
      } catch (error) {
        throw new Error(describeFetchError(error));
      } finally {
        clearTimeout(timer);
      }

      const { json, text } = await readResponseBody(res);

      if (!json) {
        throw new Error(`Telegram API returned non-JSON response (${res.status}): ${text.slice(0, 180)}`);
      }

      if (!res.ok) {
        if (res.status === 409) {
          console.error(`Telegram polling stopped: ${json.description || text.slice(0, 180)}`);
          polling = false;
          return;
        }
        throw new Error(`Telegram API error (${res.status}): ${json.description || text.slice(0, 180)}`);
      }

      if (json.ok && Array.isArray(json.result)) {
        failCount = 0;
        for (const update of json.result) {
          offset = update.update_id + 1;
          processUpdate(update).catch((err) => {
            console.error(`Telegram bot error: ${err.message}`);
          });
        }
      }
    } catch (err) {
      failCount += 1;
      console.error(`Telegram poll error (${failCount}): ${err.message}`);
      const delay = Math.min(failCount * 2000, 15000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function start(token) {
  setToken(token);

  if (!botToken) {
    console.log("TELEGRAM_BOT_TOKEN not set - Telegram bot disabled.");
    return;
  }

  if (!ENABLE_POLLING) {
    console.log("Telegram polling disabled by TELEGRAM_BOT_POLLING=false.");
    return;
  }

  poll().catch((err) => {
    console.error(`Telegram poll loop crashed: ${err.message}`);
  });
  console.log("Telegram bot started.");
}

module.exports = { start, sendMessage, setToken };
