# Air Quality Monitoring & Citizen Alert App

City AQI dashboard with citizen SMS alerts.

## Features
- Live city AQI lookup using WAQI feed data.
- India city suggestions using Open-Meteo geocoding.
- Dashboard with AQI category and key pollutant values.
- Citizen subscription endpoint for AQI threshold alerts.
- Scheduled alert worker that checks AQI every N minutes.
- Twilio SMS integration, with console fallback when credentials are missing.

## Tech
- Node.js + Express
- Static frontend (HTML/CSS/JS)
- File-based subscription store (`data/subscriptions.json`)

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy env template:
   ```bash
   copy .env.example .env
   ```
3. (Optional) Set Twilio credentials in `.env`:
4. Set WAQI token in `.env`:
   - `WAQI_TOKEN`
5. (Optional) Set Twilio credentials in `.env`:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM_PHONE`
6. Start app:
   ```bash
   npm start
   ```
7. Open `http://localhost:3000`

## API
- `GET /api/health`
- `GET /api/aqi?city=Delhi`
- `GET /api/subscriptions`
- `POST /api/subscribe`
  ```json
  {
    "name": "Anita",
    "phone": "+919900001234",
    "city": "Delhi",
    "threshold": 120
  }
  ```

## Alert behavior
- Runs every `ALERT_CHECK_INTERVAL_MIN` (default `15`).
- Sends alert when `AQI >= threshold`.
- Per phone+city cooldown via `ALERT_COOLDOWN_MIN` (default `360`).
