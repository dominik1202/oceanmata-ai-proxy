// /api/generate.js  — Vercel Serverless Function (Node)
// CORS: immer zuerst setzen!  Accepts HTTP image URLs and Data-URLs.

export default async function handler(req, res) {
  // ---- CORS (für alle Antworten, auch Fehler) ----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

  if (req.method === "OPTIONS") {
    // Preflight erfolgreich beenden
    return res.status(200).end();
  }

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
    if (!REPLICATE_TOKEN) {
      return res.status(500).json({ error: "Missing REPLICATE_API_TOKEN" });
    }

    // Body sicher einlesen (bei Vercel kann req.body undefiniert sein)
    const rawBody = await readBody(req);
    let body = {};
    try { body = rawBody ? JSON.parse(rawBody) : {}; }
    catch (e) { return res.status(400).json({ error: "Invalid JSON", detail: String(e?.message || e) }); }

    const {
      prompt = "",
      imageDataURL,
      mode = "preview",
      width = mode === "final" ? 2000 : 1024,
      height = mode === "final" ? 2000 : 1024,
      num_inference_steps = mode === "final" ? 30 : 18
    } = body;

    if (!imageDataURL) {
      return res.status(400).json({ error: "imageDataURL is required" });
    }

    // ---- Bild vorbereiten -> image_url ----
    let image_url;

    if (typeof imageDataURL === "string" && imageDataURL.startsWith("http")) {
      // direkte HTTP-URL (Shopify/CDN)
      image_url = imageDataURL;
    } else if (typeof imageDataURL === "string" && imageDataURL.startsWith("data:image/")) {
      // Data-URL -> Bytes -> Upload zu Replicate
      let base64 = imageDataURL.split(",")[1];
      if (!base64) return res.status(400).json({ error: "invalid data URL (no base64 part)" });
      base64 = base64.replace(/\s/g, ""); // evtl. Whitespaces entfernen
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.length) return res.status(400).json({ error: "invalid data URL (empty after decode)" });

      const up = await fetch("https://api.replicate.com/v1/files", {
        method: "POST",
        headers: {
          Authorization: `Token ${REPLICATE_TOKEN}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.length)
        },
        body: bytes
      });
      if (!up.ok) {
        return res.status(500).json({ error: "upload failed", detail: await up.text().catch(()=> "") });
      }
      const file = await up.json();
      image_url = file?.urls?.get || file?.url;
      if (!image_url) return res.status(500).json({ error: "no uploaded image url" });
    } else {
      return res.status(400).json({ error: "invalid imageDataURL" });
    }

    // ---- Prediction starten: Modell-Endpoint (keine version nötig) ----
    const start = await fetch(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${REPLICATE_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          input: {
            prompt,
            image: image_url,
            width,
            height,
            num_inference_steps
          }
        })
      }
    );

    if (!start.ok) {
      return res.status(500).json({ error: "replicate start failed", detail: await start.text().catch(()=> "") });
    }

    let pred = await start.json();

    // ---- Polling bis fertig (max ~2 min) ----
    const t0 = Date.now();
    while (pred.status === "starting" || pred.status === "processing") {
      await sleep(1500);
      const chk = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
        headers: { Authorization: `Token ${REPLICATE_TOKEN}` }
      });
      pred = await chk.json();
      if (Date.now() - t0 > 120000) return res.status(504).json({ error: "timeout" });
    }

    if (pred.status !== "succeeded") {
      return res.status(500).json({ error: "generation failed", detail: pred?.error || pred?.logs || pred });
    }

    const out = Array.isArray(pred.output) ? pred.output : [pred.output];
    const imageUrl = out[0];
    if (!imageUrl) return res.status(500).json({ error: "no output image" });

    return res.status(200).json({ imageUrl });
  } catch (e) {
    // Immer JSON zurückgeben (sonst zeigt der Browser „Failed to fetch“)
    return res.status(500).json({ error: "unhandled", detail: String(e?.message || e) });
  }
}

// ---- Helpers ----
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function readBody(req){
  return new Promise((resolve, reject) => {
    let data = "";
    try {
      req.setEncoding("utf8");
      req.on("data", chunk => { data += chunk; });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    } catch (e) { reject(e); }
  });
}
