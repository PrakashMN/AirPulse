# Air Quality Monitoring & Citizen Alert App

City AQI dashboard with citizen SMS alerts.

## Features

- Live city AQI lookup using WAQI feed data
- India city suggestions using Open-Meteo geocoding
- Dashboard with AQI category and key pollutant values (PM2.5, PM10, CO, NO2, Ozone)
- Citizen subscription endpoint for AQI threshold alerts
- Scheduled alert worker that checks AQI at configurable intervals
- Twilio SMS integration, with console fallback when credentials are missing

## Tech Stack

- Node.js + Express
- Static frontend (HTML/CSS/JS)
- File-based subscription store created automatically at runtime (`data/subscriptions.json`)

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- npm (comes with Node.js)

### 1. Clone the Repository

```bash
git clone https://github.com/PrakashMN/AirPulse.git
cd AirPulse
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up Environment Variables

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Or on Windows:

```bash
copy .env.example .env
```

Then edit `.env` with your configuration:

```env
PORT=3000
ALERT_CHECK_INTERVAL_MIN=15
ALERT_COOLDOWN_MIN=360

# Required for live AQI data
WAQI_TOKEN=your_waqi_api_token_here

# Optional: Required only for real SMS alerts (console fallback works without these)
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM_PHONE=your_twilio_phone_number
```

#### Where to Get API Keys

- **WAQI Token**: Sign up at [WAQI](https://aqicn.org/data-platform/token/) to get a free API token
- **Twilio Credentials**: Sign up at [Twilio](https://www.twilio.com/) for SMS alerts

### 4. Start the Application

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

### 5. Access the App

Open your browser and navigate to:

```
http://localhost:3000
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/aqi?city=Delhi` | Get AQI data for a city |
| GET | `/api/cities?q=delhi&limit=6` | Search Indian cities |
| GET | `/api/subscriptions` | List all subscriptions |
| POST | `/api/subscribe` | Subscribe to AQI alerts |

### Subscribe to Alerts

```json
POST /api/subscribe
{
  "name": "Anita",
  "phone": "+919900001234",
  "city": "Delhi",
  "threshold": 120
}
```

---

## Alert Behavior

- Runs every `ALERT_CHECK_INTERVAL_MIN` minutes (default: `15`)
- Sends SMS alert when `AQI >= user_threshold`
- Per phone+city cooldown via `ALERT_COOLDOWN_MIN` (default: `360` minutes)

---

## Deployment

### Render

1. Push this repo to GitHub
2. Create a new Web Service on [Render](https://render.com/) and connect your repo
3. Render will auto-detect the [`render.yaml`](render.yaml) configuration
4. Set the following environment variables in the Render dashboard:
   - `WAQI_TOKEN` (required)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_PHONE` (optional, for real SMS)
5. Click Deploy

Health check endpoint: `/api/health`

---

## Project Structure

```
Air-Quality/
├── data/                  # Auto-created subscription store
│   └── subscriptions.json
├── public/                # Static frontend files
│   ├── index.html
│   ├── script.js
│   └── style.css
├── .env                   # Environment variables (create from example)
├── .gitignore
├── package.json
├── render.yaml            # Render deployment config
└── server.js              # Main Express server
```
