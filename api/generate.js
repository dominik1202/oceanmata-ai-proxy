// api/generate.js — Vercel Serverless Function (Node)
// Robust: liest den Body manuell, akzeptiert Bild-HTTP-URLs UND Data-URLs,
// ruft Replicate (black-forest-labs/flux-kontext-pro) über das Modell-Endpoint auf,
// gibt bei jedem Fehler ein JSON zurück (kein Crash).

export default async function handler(req, res) {
  try {
    // ---------- CORS ----------
    const origins = (process.env.ALLOWED_ORIGINS || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    const origin = req.headers.origin || "";
    if (origins.length && origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    } else if (!origins.length) {
      // Für erste Tests offen lassen; später Domains setzen.
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
    if (!REPLICATE_TOKEN) return res.status(500).json({ error: "Missing REPLICATE_API_TOKEN" });

    // ---------- Body sicher einlesen ----------
    const rawBody = await readBody(req); // immer String
    let payload = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch (e) {
      return res.status(400).json({ error: "Invalid JSON", detail: String(e && e.message || e) });
    }

    const {
      prompt = "",
      imageDataURL,
      mode = "preview",
      width = mode === "final" ? 2000 : 1024,
      height = mode === "final" ? 2000 : 1024,
      num_inference_steps = mode === "final" ? 30 : 18
    } = payload;

    if (!imageDataURL) return res.status(400).json({ error: "imageDataURL is required" });

    // ---------- Bildquelle vorbereiten ----------
    let image_url;
    if (typeof imageDataURL === "string" && imageDataURL.startsWith("http")) {
      image_url = imageDataURL; // direkte URL (Shopify/CDN)
    } else if (typeof imageDataURL === "string" && imageDataURL.startsWith("data:image/")) {
      const base64 = imageDataURL.split(",")[1];
      if (!base64) return res.status(400).json({ error: "invalid data URL" });

      const up = await fetch("https://api.replicate.com/v1/files", {
        method: "POST",
        headers: {
          Authorization: `Token ${REPLICATE_TOKEN}`,
          "Content-Type": "application/octet-stream",
        },
        body: Buffer.from(base64, "base64"),
      });
      if (!up.ok) {
        return res.status(500).json({ error: "upload failed", detail: await up.text() });
      }
      const file = await up.json();
      image_url = file?.urls?.get || file?.url;
      if (!image_url) return res.status(500).json({ error: "no uploaded image url" });
    } else {
      return res.status(400).json({ error: "invalid imageDataURL" });
    }

    // ---------- Prediction starten (Modell-Endpoint) ----------
    const start = await fetch(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${REPLICATE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: {
            prompt,
            image: image_url,
            width,
            height,
            num_inference_steps
          }
        }),
      }
    );

    if (!start.ok) {
      return res.status(500).json({ error: "replicate start failed", detail: await start.text() });
    }

    let pred = await start.json();

    // ---------- Polling ----------
    const t0 = Date.now();
    while (pred.status === "starting" || pred.status === "processing") {
      await sleep(1500);
      const chk = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
        headers: { Authorization: `Token ${REPLICATE_TOKEN}` },
      });
      pred = await chk.json();
      if (Date.now() - t0 > 120000) return res.status(504).json({ error: "timeout" });
    }

    if (pred.status !== "succeeded") {
      return res.status(500).json({
        error: "generation failed",
        detail: pred?.error || pred?.logs || pred
      });
    }

    const out = Array.isArray(pred.output) ? pred.output : [pred.output];
    const imageUrl = out[0];
    if (!imageUrl) return res.status(500).json({ error: "no output image" });

    return res.status(200).json({ imageUrl });
  } catch (e) {
    // Falls außerhalb des inneren try/catch was schiefgeht → niemals crashen
    return res.status(500).json({ error: "unhandled", detail: String(e && e.message || e) });
  }
}

// --------- Helpers ---------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    try {
      let data = "";
      req.setEncoding("utf8");
      req.on("data", chunk => { data += chunk; });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    } catch (e) { reject(e); }
  });
}
