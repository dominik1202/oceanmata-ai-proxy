// api/generate.js — Vercel Serverless Function
// Akzeptiert imageDataURL als HTTP-URL ODER Data-URL (base64)
// Nutzt Replicate: black-forest-labs/flux-kontext-pro

export default async function handler(req, res) {
  // --- CORS (optional einschränken über ALLOWED_ORIGINS) ---
  const origins = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (origins.length && origins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (!origins.length) {
    res.setHeader("Access-Control-Allow-Origin", "*"); // für Tests ok
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_TOKEN) return res.status(500).json({ error: "Missing REPLICATE_API_TOKEN" });

  try {
    // Body sicher parsen
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const {
      prompt = "",
      imageDataURL,
      mode = "preview",
      width = mode === "final" ? 2000 : 1024,
      height = mode === "final" ? 2000 : 1024,
      num_inference_steps = mode === "final" ? 30 : 18
    } = body;

    if (!imageDataURL) return res.status(400).json({ error: "imageDataURL is required" });

    // --- Bild-Quelle vorbereiten -> image_url ---
    let image_url;

    if (typeof imageDataURL === "string" && imageDataURL.startsWith("http")) {
      // Normale Bild-URL (Shopify, CDN, etc.)
      image_url = imageDataURL;
    } else if (typeof imageDataURL === "string" && imageDataURL.startsWith("data:image/")) {
      // Data-URL -> Upload zu Replicate -> URL erhalten
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
      if (!up.ok) return res.status(500).json({ error: "upload failed", detail: await up.text() });
      const file = await up.json();
      image_url = file?.urls?.get || file?.url;
    } else {
      return res.status(400).json({ error: "invalid imageDataURL" });
    }

    // --- Prediction starten (flux-kontext-pro) ---
    const start = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "black-forest-labs/flux-kontext-pro",
        input: {
          prompt,
          image: image_url,
          width,
          height,
          num_inference_steps
          // guidance, seed etc. kannst du später ergänzen
        }
      }),
    });
    if (!start.ok) return res.status(500).json({ error: "replicate start failed", detail: await start.text() });
    let pred = await start.json();

    // --- Polling bis fertig ---
    const t0 = Date.now();
    while (pred.status === "starting" || pred.status === "processing") {
      await new Promise((z) => setTimeout(z, 1500));
      const chk = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
        headers: { Authorization: `Token ${REPLICATE_TOKEN}` },
      });
      pred = await chk.json();
      if (Date.now() - t0 > 120000) return res.status(504).json({ error: "timeout" });
    }

    if (pred.status !== "succeeded") {
      return res.status(500).json({ error: "generation failed", detail: pred?.error || pred?.logs });
    }

    const out = Array.isArray(pred.output) ? pred.output : [pred.output];
    return res.status(200).json({ imageUrl: out[0] });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "server error" });
  }
}
