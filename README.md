# Online Home Power System

This project is designed for a JBD BMS connected to an ESP32 running ESPHome. The ESP32 pushes live battery telemetry to a Cloudflare Worker, and the Worker stores the latest sample in KV while keeping compact 60-second history for long-term monitoring.

## Architecture

- ESP32 + ESPHome sends battery data every 300 ms
- Cloudflare Worker receives telemetry on `/api/ingest`
- Worker stores:
  - latest sample in `latest` KV key
  - compact 60-second summaries in `history` KV key
- GitHub Pages hosts the dashboard in `index.html`
- The dashboard polls the Worker for the latest live data and recent history

## Deployment steps

### 1) Create the Cloudflare KV namespace

```bash
wrangler kv:namespace create BATTERY_KV
```

Copy the generated namespace ID into `wrangler.toml`.

### 2) Configure the Worker secret

In `wrangler.toml`, set:

```toml
[vars]
API_TOKEN = "CHANGE_ME"
```

Or set it with:

```bash
wrangler secret put API_TOKEN
```

### 3) Deploy the Worker

```bash
wrangler deploy
```

### 4) Update ESPHome config

Replace the placeholder URL and token in the ESPHome YAML:

```yaml
url: "https://your-worker.example.workers.dev/api/ingest"
Authorization: "Bearer CHANGE_ME"
```

### 5) Host the dashboard

Upload `index.html` to GitHub Pages or any static host.

Update the Worker URL in the dashboard script if needed:

```javascript
const workerUrl = "https://your-worker.example.workers.dev";
```

## Notes

- Live readings are received from the ESP32 at 300 ms, but they are only retained in the latest sample bucket.
- History is compacted to 60-second intervals to stay under Cloudflare free-tier limits.
- The dashboard only pulls live data when the page is open, keeping the browser lightweight.
