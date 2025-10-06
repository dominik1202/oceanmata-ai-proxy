export default async function handler(req, res) {
  // --- CORS (von welchen Webseiten Anfragen erlaubt sind) ---
  const origins = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (origins.length && origins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_TOKEN) return res.status(500).json({ error: "Missing REPLICATE_API_TOKEN" });

  try {
    const {
      prompt = "",
      negative_prompt = "low quality, blurry, artifacts, watermark, text",
      imageDataURL,
      width = 1024,
      height = 1024,
      strength = 0.65,
      guidance = 7.0,
      seed = null,
      scheduler = "K_EULER",
      mode = "preview",
    } = req.body || {};

    if (!imageDataURL) return res.status(400).json({ error: "imageDataURL is required" });

    // DataURL -> Base64
    const base64 = String(imageDataURL).split(",")[1];
    if (!base64) return res.status(400).json({ error: "invalid imageDataURL" });

    // 1) Bild zu Replicate hochladen (gibt uns eine URL)
    const uploadResp = await fetch("https://api.replicate.com/v1/files", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_TOKEN}`,
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.from(base64, "base64"),
    });
    if (!uploadResp.ok) {
      const t = await uploadResp.text();
      return res.status(500).json({ error: "upload failed", detail: t });
    }
    const uploaded = await uploadResp.json();
    const image_url = uploaded?.urls?.get || uploaded?.url;
    if (!image_url) return res.status(500).json({ error: "no uploaded image url" });

    // 2) SDXL Image-to-Image starten
    const w = mode === "final" ? Math.min(2000, width) : Math.min(1024, width);
    const h = mode === "final" ? Math.min(2000, height) : Math.min(1024, height);
    const str = Math.max(0, Math.min(1, strength));

    const start = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "stability-ai/sdxl",
        input: {
          prompt,
          negative_prompt,
          image: image_url,
          strength: str,           // 0..1 wie stark vom Prompt überlagern
          width: w,
          height: h,
          guidance_scale: guidance,
          scheduler,
          seed
        },
      }),
    });
    if (!start.ok) {
      const t = await start.text();
      return res.status(500).json({ error: "replicate start failed", detail: t });
    }
    let pred = await start.json();

    // 3) Warten bis fertig
    const begin = Date.now();
    while (pred.status === "starting" || pred.status === "processing") {
      await new Promise((z) => setTimeout(z, 1500));
      const check = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
        headers: { Authorization: `Token ${REPLICATE_TOKEN}` },
      });
      pred = await check.json();
      if (Date.now() - begin > 120000) return res.status(504).json({ error: "timeout" });
    }

    if (pred.status !== "succeeded") {
      return res.status(500).json({ error: "generation failed", detail: pred?.error || pred?.logs });
    }

    const output = Array.isArray(pred.output) ? pred.output : [pred.output];
    const imageUrl = output[0];
    if (!imageUrl) return res.status(500).json({ error: "no output image" });

    return res.status(200).json({ imageUrl });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "server error" });
  }
}
