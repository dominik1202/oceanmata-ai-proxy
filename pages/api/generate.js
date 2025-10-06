export default async function handler(req, res) {
  // --- CORS ---
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
      imageDataURL,
      // optionale Felder – viele Modelle ignorieren width/height und nutzen die Bildgröße
      width = 1024,
      height = 1024,
      mode = "preview"
    } = req.body || {};

    if (!imageDataURL) return res.status(400).json({ error: "imageDataURL is required" });

    const base64 = String(imageDataURL).split(",")[1];
    if (!base64) return res.status(400).json({ error: "invalid imageDataURL" });

    // 1) Upload zu Replicate, damit wir eine URL haben
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

    // 2) flux-kontext-pro auf Replicate starten (kontextbasiertes Editieren)
    const start = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "black-forest-labs/flux-kontext-pro",
        input: {
          // Minimal nötig:
          prompt,         // z.B. "increase turquoise 20%, smoother texture"
          image: image_url,
          // Häufig akzeptierte optionale Parameter:
          width, height,              // kann ignoriert werden, je nach Modell
          num_inference_steps: mode === "final" ? 30 : 18,
          guidance: 3.5,              // niedriger als SDXL üblich; Model folgt Prompts gut
          seed: null                  // null = random
          // Wenn das Modell Spalten anders nennt, ignoriert es unbekannte Felder einfach.
        }
      }),
    });
    if (!start.ok) {
      const t = await start.text();
      return res.status(500).json({ error: "replicate start failed", detail: t });
    }
    let pred = await start.json();

    // 3) Polling bis fertig
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
