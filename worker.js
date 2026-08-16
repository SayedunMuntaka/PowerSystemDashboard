export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS headers so your frontend can communicate with the worker
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Helper function to normalize and parse payloads correctly
    function parseAndNormalizePayload(rawPayload) {
      try {
        const body = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
        
        // Normalize the balancing field from whatever format ESPHome sent it in
        const rawBalancing = body.balancing ?? body.is_balancing ?? body.balance ?? body.balancing_status;
        const isBalancing = rawBalancing === true || rawBalancing === "true" || rawBalancing === 1 || rawBalancing === "1";

        return {
          ...body,
          balancing: isBalancing
        };
      } catch (e) {
        return typeof rawPayload === "string" ? JSON.parse(rawPayload || "{}") : rawPayload;
      }
    }

    // 1. INGEST DATA (POST from ESP32)
    if (request.method === "POST" && url.pathname.startsWith("/api/telemetry")) {
      try {
        const body = await request.json();
        const device = body.device || "jbd-bms-ble";
        
        // Add a timestamp if the ESP32 didn't provide one
        if (!body.ts) {
          body.ts = Date.now();
        }

        // Store the ENTIRE JSON payload so no metrics are lost
        const rawPayload = JSON.stringify(body);

        await env.DB.prepare(
          `INSERT INTO bms_telemetry (device, raw_payload) VALUES (?, ?)`
        ).bind(device, rawPayload).run();

        return new Response(JSON.stringify({ success: true }), { 
          status: 200, 
          headers: { "Content-Type": "application/json", ...corsHeaders } 
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { 
          status: 500, 
          headers: { "Content-Type": "application/json", ...corsHeaders } 
        });
      }
    }

    // 2. LIVE DASHBOARD DATA (Only fetches the 1 latest row)
    if (request.method === "GET" && url.pathname === "/api/live") {
      const device = url.searchParams.get("device") || "jbd-bms-ble";
      try {
        const { results } = await env.DB.prepare(
          `SELECT raw_payload FROM bms_telemetry WHERE device = ? ORDER BY id DESC LIMIT 1`
        ).bind(device).all();

        if (results && results.length > 0) {
          const normalized = parseAndNormalizePayload(results[0].raw_payload);
          return new Response(JSON.stringify(normalized), { 
            status: 200, 
            headers: { "Content-Type": "application/json", ...corsHeaders } 
          });
        }
        return new Response("{}", { 
          status: 200, 
          headers: { "Content-Type": "application/json", ...corsHeaders } 
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // 3. HISTORY CHART DATA (Fetches the last ~10-15 minutes of points for the chart)
    if (request.method === "GET" && url.pathname === "/api/history") {
      const device = url.searchParams.get("device") || "jbd-bms-ble";
      try {
        const { results } = await env.DB.prepare(
          `SELECT raw_payload FROM bms_telemetry WHERE device = ? ORDER BY id DESC LIMIT 200`
        ).bind(device).all();

        // Parse JSON, normalize balancing fields, and reverse so it plots chronologically
        const items = results.map(row => parseAndNormalizePayload(row.raw_payload)).reverse();

        return new Response(JSON.stringify({ items }), { 
          status: 200, 
          headers: { "Content-Type": "application/json", ...corsHeaders } 
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // 4. AVAILABLE MONTHS ENDPOINT (Lists distinct months from bms_telemetry json)
    if (request.method === "GET" && url.pathname === '/api/available-months') {
      const device = url.searchParams.get('device') || 'jbd-bms-ble';
      try {
        const query = `
          SELECT DISTINCT strftime('%Y-%m', datetime(json_extract(raw_payload, '$.ts') / 1000, 'unixepoch')) as month_str 
          FROM bms_telemetry 
          WHERE device = ? 
          ORDER BY month_str DESC;
        `;
        const result = await env.DB.prepare(query).bind(device).all();
        const months = (result.results || []).map(r => r.month_str).filter(Boolean);
        return new Response(JSON.stringify({ months }), { 
          status: 200, 
          headers: { 'Content-Type': 'application/json', ...corsHeaders } 
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // 5. DAILY HISTORY FILTERED BY MONTH ENDPOINT
    if (request.method === "GET" && url.pathname === '/api/daily-history') {
      const device = url.searchParams.get('device') || 'jbd-bms-ble';
      const selectedMonth = url.searchParams.get('month'); // Format: YYYY-MM

      try {
        // Power is stored in watts. We integrate each sample forward to the next
        // telemetry sample to calculate daily energy in Wh. The interval is capped
        // at 60 seconds so a Wi-Fi/ESP32 outage does not create fake energy.
        const query = `
          WITH telemetry AS (
            SELECT
              id,
              CAST(json_extract(raw_payload, '$.ts') AS REAL) AS ts_ms,
              CAST(json_extract(raw_payload, '$.power') AS REAL) AS power_w,
              date(datetime(json_extract(raw_payload, '$.ts') / 1000, 'unixepoch')) AS sample_date,
              strftime('%Y-%m', datetime(json_extract(raw_payload, '$.ts') / 1000, 'unixepoch')) AS sample_month,
              LEAD(CAST(json_extract(raw_payload, '$.ts') AS REAL)) OVER (
                PARTITION BY device ORDER BY id
              ) AS next_ts_ms
            FROM bms_telemetry
            WHERE device = ?
          ),
          daily AS (
            SELECT
              sample_date AS date,
              COUNT(*) AS entries,
              SUM(
                CASE
                  WHEN power_w > 0 AND next_ts_ms > ts_ms THEN
                    power_w * MIN(next_ts_ms - ts_ms, 60000.0) / 3600000.0
                  ELSE 0
                END
              ) AS charged_wh,
              SUM(
                CASE
                  WHEN power_w < 0 AND next_ts_ms > ts_ms THEN
                    (-power_w) * MIN(next_ts_ms - ts_ms, 60000.0) / 3600000.0
                  ELSE 0
                END
              ) AS discharged_wh
            FROM telemetry
            WHERE (? IS NULL OR sample_month = ?)
            GROUP BY sample_date
          )
          SELECT
            date,
            entries,
            ROUND(COALESCE(charged_wh, 0), 2) AS charged_wh,
            ROUND(COALESCE(discharged_wh, 0), 2) AS discharged_wh,
            ROUND(COALESCE(charged_wh, 0) + COALESCE(discharged_wh, 0), 2) AS total_wh
          FROM daily
          ORDER BY date DESC
          LIMIT 31;
        `;

        const result = await env.DB.prepare(query)
          .bind(device, selectedMonth || null, selectedMonth || null)
          .all();

        return new Response(JSON.stringify({ items: result.results || [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};