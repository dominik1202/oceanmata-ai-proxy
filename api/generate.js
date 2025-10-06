// api/generate.js — Vercel Serverless Function
// Akzeptiert imageDataURL als HTTP-URL ODER als Data-URL (base64).
// Ruft Replicate: black-forest-labs/flux-kontext-pro über das Modell-Endpoint auf.

export default async function handler(req, res) {
  // --- CORS (für Tests permissiv; später ALLOWED_ORIGINS setzen) ---
  const origins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin || "";
  if (origins.length) {
    if (origins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // Fallback für erste Tests
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_TOKEN) return res.status(500).json({ error: "Missing REPLICATE_API_TOKEN" });

  try {
    // Body sicher parsen (kann String oder Objekt sein)
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    const {
      prompt = "",
      imageDataURL,
      mode = "preview",
      // optionale Parameter
      width = mode === "final" ? 2000 : 1024,
      height = mode === "final" ? 2000 : 1024,
      num_inference_steps = mode === "final" ? 30 : 18
      // guidance, seed etc. kannst du später ergänzen
    } = body;

    if (!imageDataURL) return res.status(400).json({ error: "imageDataURL is required" });

    // === Bildquelle vorbereiten -> image_url ===
    let image_url;

    if (typeof imageDataURL === "string" && imageDataURL.startsWith("http")) {
      // Direkte Bild-URL (z. B. Shopify CDN)
      image_url = imageDataURL;
    } else if (typeof imageDataURL === "string" && imageDataURL.startsWith("data:image/")) {
      // Data-URL -> Upload zu Replicate (liefert temporäre URL)
      const base64 = imageDataURL.split(",")[1];
      if (!base64) return res.status(400).json({ error: "invalid data URL" });

      const up = await fetch("https://api.replicate.com/v1/files", {
        method: "POST",
        headers: {
          Auth
