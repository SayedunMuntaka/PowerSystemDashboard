const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}

function sanitizeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSample(raw) {
  if (!raw || typeof raw !== "object") return null;

  const generatedCells = [];
  const cellKeys = ["cell_voltage_1", "cell_voltage_2", "cell_voltage_3", "cell_voltage_4", "cell_1", "cell_2", "cell_3", "cell_4"];
  for (const key of cellKeys) {
    if (raw[key] !== undefined) {
      generatedCells.push(sanitizeNumber(raw[key]));
    }
  }

  const cellVoltages = Array.isArray(raw.cell_voltages)
    ? raw.cell_voltages.map((v) => sanitizeNumber(v))
    : generatedCells.length
      ? generatedCells
      : [];

  const rawCapacityCandidates = [
    raw.capacity_remaining,
    raw.remaining_capacity,
    raw.capacity,
    raw.capacity_ah,
    raw.remaining_capacity_ah
  ];

  const rawCapacity = rawCapacityCandidates
    .map((value) => sanitizeNumber(value))
    .find((value) => value > 0) || 0;

  const nominalCapacity = sanitizeNumber(raw.nominal_capacity);
  const soc = sanitizeNumber(raw.state_of_charge);
  const derivedCapacity = nominalCapacity > 0 && soc > 0 ? (nominalCapacity * soc) / 100 : 0;
  const effectiveCapacity = rawCapacity > 0 ? rawCapacity : derivedCapacity;

  const sample = {
    ts: Date.now(),
    device: String(raw.device || "bms"),
    total_voltage: sanitizeNumber(raw.total_voltage),
    current: sanitizeNumber(raw.current),
    power: sanitizeNumber(raw.power),
    state_of_charge: soc,
    capacity_remaining: effectiveCapacity,
    nominal_capacity: nominalCapacity,
    remaining_charging_time: sanitizeNumber(raw.remaining_charging_time),
    remaining_discharging_time: sanitizeNumber(raw.remaining_discharging_time),
    temperature_1: sanitizeNumber(raw.temperature_1),
    charging: raw.charging === true || raw.charging === 1 || raw.charging === "true",
    discharging: raw.discharging === true || raw.discharging === 1 || raw.discharging === "true",
    balancing: raw.balancing === true || raw.balancing === 1 || raw.balancing === "true",
    online_status: raw.online_status === true || raw.online_status === 1 || raw.online_status === "true",
    delta_cell_voltage: sanitizeNumber(raw.delta_cell_voltage),
    cell_voltages: cellVoltages
  };

  return sample;
}

function compactHistoryFor7Days(history) {
  const now = Date.now();
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  const cutoff = now - maxAgeMs;
  return (Array.isArray(history) ? history : []).filter((entry) => Number(entry.ts) >= cutoff);
}

async function getLatestForDevice(env, requestedDevice) {
  const candidates = [];
  if (requestedDevice) candidates.push(String(requestedDevice));
  candidates.push("jbd-bms-ble", "bms", "battery", "default");

  const seen = new Set();
  for (const candidate of candidates) {
    const name = String(candidate || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const raw = await env.BATTERY_KV.get(`${name}:latest`);
    if (raw) {
      try {
        return { device: name, data: JSON.parse(raw) };
      } catch (error) {
        return { device: name, data: null };
      }
    }
  }

  return null;
}

async function getHistoryForDevice(env, requestedDevice) {
  const candidates = [];
  if (requestedDevice) candidates.push(String(requestedDevice));
  candidates.push("jbd-bms-ble", "bms", "battery", "default");

  const seen = new Set();
  for (const candidate of candidates) {
    const name = String(candidate || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const raw = await env.BATTERY_KV.get(`${name}:history`);
    if (raw) {
      try {
        return { device: name, items: JSON.parse(raw) };
      } catch (error) {
        return { device: name, items: [] };
      }
    }
  }

  return { device: requestedDevice || "bms", items: [] };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const auth = request.headers.get("Authorization") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return jsonResponse({ ok: true, status: "worker-online", time: Date.now() });
    }

    const isProtectedWrite = request.method === "POST" && url.pathname === "/api/ingest";
    if (isProtectedWrite && env.API_TOKEN && auth !== `Bearer ${env.API_TOKEN}`) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    if (url.pathname === "/api/health") {
      return jsonResponse({ ok: true, status: "worker-online", time: Date.now() });
    }

    if (url.pathname === "/api/live" && request.method === "GET") {
      if (!env.BATTERY_KV) {
        return jsonResponse({ ok: false, error: "Storage not configured", device: url.searchParams.get("device") || "bms" }, 503);
      }

      const device = url.searchParams.get("device") || "bms";
      const resolved = await getLatestForDevice(env, device);
      if (!resolved || !resolved.data) {
        return jsonResponse({ ok: false, error: "No live sample yet", device }, 404);
      }
      return jsonResponse({ ...resolved.data, device: resolved.device });
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      if (!env.BATTERY_KV) {
        return jsonResponse({ ok: true, device: url.searchParams.get("device") || "bms", items: [] }, 200);
      }

      const device = url.searchParams.get("device") || "bms";
      const resolved = await getHistoryForDevice(env, device);
      const items = Array.isArray(resolved.items) ? resolved.items : [];
      const compacted = compactHistoryFor7Days(items);
      return jsonResponse({ ok: true, device: resolved.device, items: compacted });
    }

    if (url.pathname === "/api/ingest" && request.method === "POST") {
      if (!env.BATTERY_KV) {
        return jsonResponse({ ok: false, error: "Storage not configured" }, 503);
      }

      let payload;
      try {
        payload = await request.json();
      } catch (error) {
        return jsonResponse({ ok: false, error: "Invalid JSON payload" }, 400);
      }

      const sample = normalizeSample(payload);
      if (!sample) {
        return jsonResponse({ ok: false, error: "Missing valid sample payload" }, 400);
      }

      const device = sample.device || "bms";
      const latestKey = `${device}:latest`;
      const historyKey = `${device}:history`;

      await env.BATTERY_KV.put(latestKey, JSON.stringify(sample), {
        expirationTtl: 86400 * 2
      });

      const currentBucket = Math.floor(sample.ts / 60000);
      let history = [];
      const currentHistory = await env.BATTERY_KV.get(historyKey);
      if (currentHistory) {
        try {
          history = JSON.parse(currentHistory);
        } catch (error) {
          history = [];
        }
      }

      if (!Array.isArray(history)) history = [];

      const last = history[history.length - 1];
      const lastBucket = last ? Math.floor(Number(last.ts) / 60000) : null;

      if (!last || lastBucket !== currentBucket) {
        history.push({
          ts: sample.ts,
          total_voltage: sample.total_voltage,
          current: sample.current,
          power: sample.power,
          state_of_charge: sample.state_of_charge,
          temperature_1: sample.temperature_1,
          charging: sample.charging,
          discharging: sample.discharging,
          balancing: sample.balancing,
          online_status: sample.online_status,
          cell_voltages: sample.cell_voltages
        });
      } else {
        history[history.length - 1] = {
          ...last,
          ts: sample.ts,
          total_voltage: sample.total_voltage,
          current: sample.current,
          power: sample.power,
          state_of_charge: sample.state_of_charge,
          temperature_1: sample.temperature_1,
          charging: sample.charging,
          discharging: sample.discharging,
          balancing: sample.balancing,
          online_status: sample.online_status,
          cell_voltages: sample.cell_voltages
        };
      }

      const historyLimitMs = 7 * 24 * 60 * 60 * 1000;
      const minimumTs = Date.now() - historyLimitMs;
      history = history.filter((entry) => Number(entry.ts) >= minimumTs);

      if (history.length > 10080) {
        history = history.slice(-10080);
      }

      await env.BATTERY_KV.put(historyKey, JSON.stringify(history), {
        expirationTtl: 86400 * 30
      });

      return jsonResponse({ ok: true, device, ts: sample.ts, accepted: true });
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404);
  }
};
