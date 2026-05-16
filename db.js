const fs = require("fs/promises");
const path = require("path");

const SUBS_FILE = path.join(__dirname, "data", "subscriptions.json");

function toTitleCase(input) {
  return input
    .trim()
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function readSubscriptions() {
  try {
    const raw = await fs.readFile(SUBS_FILE, "utf8");
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    return [];
  }
}

async function ensureSubscriptionsStore() {
  await fs.mkdir(path.dirname(SUBS_FILE), { recursive: true });
  try {
    await fs.access(SUBS_FILE);
  } catch (_error) {
    await fs.writeFile(SUBS_FILE, "[]", "utf8");
  }
}

async function writeSubscriptions(subscriptions) {
  await ensureSubscriptionsStore();
  await fs.writeFile(SUBS_FILE, JSON.stringify(subscriptions, null, 2), "utf8");
}

module.exports = { toTitleCase, readSubscriptions, writeSubscriptions, ensureSubscriptionsStore };
