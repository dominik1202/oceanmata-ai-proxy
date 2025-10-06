// api/generate.js  — Vercel Serverless Function (Node)
// Ziel: Bild (DataURL) + Prompt an Replicate "black-forest-labs/flux-kontext-pro" schicken.
// Antwort: { imageUrl }

export default async function handler(req, res) {
  // --- CORS (erlaubte Herkunftsdomains optional einschränken) ---
  const origins = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (origins.length && origins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (!origins.length) {
    // Fallback: für erste Tests alles erlauben (später entfernen!)
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_TOKEN) {
    return res.status(500).json({ error: "Missing REPLICATE_API_TOKEN" });
  }

  try {
    // Body sicher parsen (manchmal ist req.body schon Objekt, manchmal String)
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const {
      prompt = "",
      imageDataURL,
      mode = "preview",
      // optional – das Model kann interne Größe wählen, wir reichen trotzdem weiter:
      width = mode === "final" ? 2000 : 1024,
      height = mode === "final" ? 2000 : 1024,
      num_inference_steps = mode === "final" ? 30 : 18
    } = body;

    if (!imageDataURL) return res.status(400).json({ error: "imageDataURL is required" });

    // DataURL → base64-Bytes
    const base64 = String(imageDataURL).split(",")[1];
    if (!base64) return res.status(400).json({ error: "invalid imageDataURL" });

    // 1) Upload zu Replicate (liefert temporäre URL)
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
    const image_url = file?.urls?.get || file?.url;
    if (!image_url) return res.status(500).json({ error: "no uploaded image url" });

    // 2) Prediction starten – flux-kontext-pro
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
          // guidance/seed usw. kannst du später ergänzen
        }
      }),
    });
    if (!start.ok) {
      return res.status(500).json({ error: "replicate start failed", detail: await start.text() });
    }
    let pred = await start.json();

    // 3) Polling bis fertig
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
