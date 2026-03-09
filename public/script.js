const seedCities = [
  "Delhi",
  "Mumbai",
  "Bengaluru",
  "Chennai",
  "Hyderabad",
  "Kolkata",
  "Pune",
  "Ahmedabad",
  "Jaipur",
  "Lucknow",
  "Chandigarh",
  "Bhopal"
];

const fallbackCities = [
  { city: "Delhi", region: "India - NCR", aqi: 312, pm25: 198, pm10: 285, o3: 18, no2: 62, co: 2.1, category: "Hazardous", observedAt: null },
  { city: "Mumbai", region: "India - Maharashtra", aqi: 142, pm25: 78, pm10: 130, o3: 32, no2: 40, co: 1.4, category: "Unhealthy", observedAt: null },
  { city: "Bengaluru", region: "India - Karnataka", aqi: 72, pm25: 30, pm10: 58, o3: 44, no2: 22, co: 0.9, category: "Moderate", observedAt: null },
  { city: "Kolkata", region: "India - West Bengal", aqi: 178, pm25: 102, pm10: 160, o3: 22, no2: 48, co: 1.7, category: "Unhealthy", observedAt: null },
  { city: "Chennai", region: "India - Tamil Nadu", aqi: 95, pm25: 48, pm10: 82, o3: 38, no2: 28, co: 1.0, category: "Moderate", observedAt: null }
];

const grid = document.getElementById("aqiGrid");
const detailSec = document.getElementById("detailSection");
const aqiSec = document.querySelector(".aqi-section");
const detailHeader = document.getElementById("detailHeader");
const pollutantGrid = document.getElementById("pollutantGrid");
const aqiChart = document.getElementById("aqiChart");
const citySearch = document.getElementById("citySearch");
const citySelect = document.getElementById("userCity");
const formStatus = document.getElementById("formStatus");
const formSuccess = document.getElementById("formSuccess");

let allCities = [];
let visibleCities = [];
let activeFilter = "all";

function levelFromAqi(aqi) {
  if (aqi <= 50) return { label: "Good", color: "#4ade80", filter: "good" };
  if (aqi <= 100) return { label: "Moderate", color: "#facc15", filter: "moderate" };
  if (aqi <= 200) return { label: "Unhealthy", color: "#fb923c", filter: "unhealthy" };
  if (aqi <= 300) return { label: "Very Unhealthy", color: "#f87171", filter: "hazardous" };
  return { label: "Hazardous", color: "#c084fc", filter: "hazardous" };
}

function levelFromCategory(category, aqi) {
  const text = String(category || "").toLowerCase();
  if (text.includes("good")) return { label: "Good", color: "#4ade80", filter: "good" };
  if (text.includes("moderate")) return { label: "Moderate", color: "#facc15", filter: "moderate" };
  if (text.includes("sensitive") || text.includes("unhealthy")) {
    if (text.includes("very") || aqi > 200) return { label: "Very Unhealthy", color: "#f87171", filter: "hazardous" };
    return { label: "Unhealthy", color: "#fb923c", filter: "unhealthy" };
  }
  if (text.includes("hazard")) return { label: "Hazardous", color: "#c084fc", filter: "hazardous" };
  return levelFromAqi(Number(aqi) || 0);
}

function healthMsg(aqi) {
  if (aqi <= 50) return "Air quality is satisfactory. Enjoy outdoor activities.";
  if (aqi <= 100) return "Acceptable air quality. Sensitive people should reduce prolonged outdoor exertion.";
  if (aqi <= 200) return "Sensitive groups may experience health effects.";
  if (aqi <= 300) return "Health alert. Everyone may begin to experience health effects.";
  return "Emergency conditions. Entire population is likely affected.";
}

function formatObserved(observedAt) {
  if (!observedAt) return "Updated recently";
  const dt = new Date(observedAt);
  if (Number.isNaN(dt.getTime())) return "Updated recently";
  return `Updated ${dt.toLocaleString()}`;
}

function randomTrend(base) {
  const result = [];
  for (let i = 0; i < 24; i += 1) {
    const delta = Math.round((Math.random() - 0.5) * base * 0.25);
    result.push(Math.max(10, base + delta));
  }
  return result;
}

function toCardCity(apiData) {
  const region = [apiData.country, apiData.region].filter(Boolean).join(" - ");
  return {
    city: apiData.city,
    region,
    aqi: apiData.aqi,
    category: apiData.category,
    observedAt: apiData.observedAt,
    pm25: apiData.pollutants?.pm25,
    pm10: apiData.pollutants?.pm10,
    o3: apiData.pollutants?.ozone,
    no2: apiData.pollutants?.no2,
    co: apiData.pollutants?.co,
  };
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

async function fetchCityAqi(city) {
  const data = await getJson(`/api/aqi?city=${encodeURIComponent(city)}`);
  return toCardCity(data);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCityWithRetry(city, retries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchCityAqi(city);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError || new Error(`Unable to load city ${city}`);
}

function renderCards(list) {
  grid.innerHTML = "";

  if (list.length === 0) {
    grid.innerHTML = "<p class='muted'>No cities match this view.</p>";
    return;
  }

  list.forEach((c, i) => {
    const lv = levelFromCategory(c.category, c.aqi);
    const card = document.createElement("div");
    card.className = "aqi-card";
    card.setAttribute("data-filter", lv.filter);
    card.style.animationDelay = `${i * 0.04}s`;

    card.innerHTML = `
      <div class="card-glow" style="background:${lv.color}"></div>
      <div class="city-name">${c.city}</div>
      <div class="city-region">${c.region || "-"}</div>
      <div class="aqi-badge" style="background:${lv.color}">${c.aqi ?? "N/A"}</div>
      <div class="aqi-label" style="color:${lv.color}">${lv.label}</div>
      <div class="mini-pollutants">
        <span class="mini-p">PM2.5 <span>${c.pm25 ?? "N/A"}</span></span>
        <span class="mini-p">PM10 <span>${c.pm10 ?? "N/A"}</span></span>
        <span class="mini-p">O3 <span>${c.o3 ?? "N/A"}</span></span>
      </div>
      <div class="update-time">${formatObserved(c.observedAt)}</div>
    `;

    card.addEventListener("click", () => showDetail(c));
    grid.appendChild(card);
  });
}

function applyViewFilter() {
  const search = citySearch.value.trim().toLowerCase();
  let next = allCities;

  if (activeFilter !== "all") {
    next = next.filter((c) => levelFromCategory(c.category, c.aqi).filter === activeFilter);
  }

  if (search) {
    next = next.filter(
      (c) => c.city.toLowerCase().includes(search) || String(c.region || "").toLowerCase().includes(search)
    );
  }

  visibleCities = next;
  renderCards(visibleCities);
}

function showDetail(c) {
  aqiSec.classList.add("hidden");
  detailSec.classList.remove("hidden");

  const lv = levelFromCategory(c.category, c.aqi);
  detailHeader.innerHTML = `
    <div class="detail-aqi" style="color:${lv.color}">${c.aqi ?? "N/A"}</div>
    <div>
      <div class="detail-city">${c.city}</div>
      <div class="detail-label" style="color:${lv.color}">${lv.label}</div>
      <div class="detail-desc">${c.region || "-"} - ${healthMsg(c.aqi || 0)}</div>
    </div>
  `;

  const pollutants = [
    { name: "PM2.5", value: c.pm25, unit: "ug/m3" },
    { name: "PM10", value: c.pm10, unit: "ug/m3" },
    { name: "O3", value: c.o3, unit: "ug/m3" },
    { name: "NO2", value: c.no2, unit: "ug/m3" },
    { name: "SO2", value: "N/A", unit: "ug/m3" },
    { name: "CO", value: c.co, unit: "ug/m3" },
  ];

  pollutantGrid.innerHTML = pollutants
    .map(
      (p) => `
      <div class="pollutant-card">
        <div class="p-name">${p.name}</div>
        <div class="p-value">${p.value ?? "N/A"}</div>
        <div class="p-unit">${p.unit}</div>
      </div>`
    )
    .join("");

  const data = randomTrend(Math.max(Number(c.aqi) || 60, 60));
  const max = Math.max(...data);
  aqiChart.innerHTML = data
    .map((v) => {
      const h = (v / max) * 120;
      const color = levelFromAqi(v).color;
      return `<div class="chart-bar" data-val="${v}" style="height:${h}px;background:${color}"></div>`;
    })
    .join("");

  window.scrollTo({ top: detailSec.offsetTop - 80, behavior: "smooth" });
}

function fillCitySelect(list) {
  const selected = citySelect.value;
  const cities = [...new Set(list.map((c) => c.city))].sort();

  citySelect.innerHTML = "<option value='' disabled selected>Choose a city</option>";
  cities.forEach((city) => {
    const option = document.createElement("option");
    option.value = city;
    option.textContent = city;
    citySelect.appendChild(option);
  });

  if (selected && cities.includes(selected)) {
    citySelect.value = selected;
  }
}

function animateCount(el, target, duration = 1200) {
  const start = performance.now();
  const step = (ts) => {
    const progress = Math.min((ts - start) / duration, 1);
    el.textContent = Math.floor(progress * target).toLocaleString();
    if (progress < 1) requestAnimationFrame(step);
    else el.textContent = target.toLocaleString();
  };
  requestAnimationFrame(step);
}

async function refreshSubscribersStat() {
  try {
    const subs = await getJson("/api/subscriptions");
    animateCount(document.getElementById("statUsers"), subs.length, 900);
  } catch (_error) {
    document.getElementById("statUsers").textContent = "0";
  }
}

async function loadInitialCities() {
  const loaded = [];
  for (const city of seedCities) {
    try {
      const data = await fetchCityWithRetry(city, 1);
      loaded.push(data);
    } catch (_error) {
      // Keep loading remaining cities even when one city fails.
    }
  }
  allCities = loaded;

  if (allCities.length === 0) {
    allCities = [...fallbackCities];
    grid.innerHTML = "<p class='muted'>Live AQI API is unavailable right now. Showing fallback city data.</p>";
  }

  fillCitySelect(allCities);
  applyViewFilter();

  animateCount(document.getElementById("statCities"), allCities.length, 900);
  document.getElementById("statAlerts").textContent = "0";
  await refreshSubscribersStat();
}

document.getElementById("filterTabs").addEventListener("click", (event) => {
  if (!event.target.classList.contains("tab")) return;

  document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
  event.target.classList.add("active");
  activeFilter = event.target.dataset.filter || "all";
  applyViewFilter();
});

citySearch.addEventListener("input", () => {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
  document.querySelector('.tab[data-filter="all"]').classList.add("active");
  activeFilter = "all";
  applyViewFilter();
});

citySearch.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();

  const city = citySearch.value.trim();
  if (!city) return;

  try {
    const data = await fetchCityWithRetry(city, 1);
    const exists = allCities.find((c) => c.city.toLowerCase() === data.city.toLowerCase());
    if (!exists) {
      allCities.push(data);
      fillCitySelect(allCities);
      animateCount(document.getElementById("statCities"), allCities.length, 500);
    }
    citySearch.value = data.city;
    applyViewFilter();
  } catch (error) {
    console.error(error.message);
    grid.insertAdjacentHTML("afterbegin", "<p class='error'>Could not fetch that city right now.</p>");
    setTimeout(() => {
      const err = grid.querySelector(".error");
      if (err) err.remove();
    }, 2500);
  }
});

document.getElementById("backBtn").addEventListener("click", () => {
  detailSec.classList.add("hidden");
  aqiSec.classList.remove("hidden");
  window.scrollTo({ top: aqiSec.offsetTop - 80, behavior: "smooth" });
});

document.getElementById("aqiThreshold").addEventListener("input", (event) => {
  document.getElementById("rangeVal").textContent = event.target.value;
});

document.getElementById("alertForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    name: document.getElementById("userName").value.trim(),
    phone: document.getElementById("userPhone").value.trim().replace(/[\s\-()]/g, ""),
    city: citySelect.value,
    threshold: Number(document.getElementById("aqiThreshold").value),
  };

  formStatus.className = "form-status";
  formStatus.textContent = "Submitting subscription...";

  try {
    await getJson("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    document.getElementById("alertForm").classList.add("hidden");
    formSuccess.classList.remove("hidden");
    formStatus.className = "form-status ok";
    formStatus.textContent = "Subscription created successfully.";

    await refreshSubscribersStat();
  } catch (error) {
    formStatus.className = "form-status error";
    formStatus.textContent = error.message;
  }
});

loadInitialCities().catch((error) => {
  grid.innerHTML = `<p class='error'>${error.message}</p>`;
});
