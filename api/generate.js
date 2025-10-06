import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    // CORS Preflight
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const { prompt, imageDataURL, mode } = req.body || {};
    const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;

    if (!REPLICATE_TOKEN) {
      return res.status(500).json({ error: "Missing REPLICATE_API_TOKEN" });
    }

    if (!imageDataURL) {
      return res.status(400).json({ error: "imageDataURL missing" });
    }

    // --- 1️⃣ Base64-Teil aus DataURL extrahieren ---
    let base64 = imageDataURL.split(",")[1];
    if (!base64) {
      return res.status(400).json({ error: "invalid data URL (no base64 part)" });
    }

    // Entferne Whitespaces oder Zeilenumbrüche (manche Browser fügen welche hinzu)
    base64 = base64.replace(/\s/g, "");

    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length) {
      return res.status(400).json({ error: "invalid data URL (empty after decode)" });
    }

    // --- 2️⃣ Datei zu Replicate hochladen ---
    const up = await fetch("https://api.replicate.com/v1/files", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_TOKEN}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    });

    if (!up.ok) {
      const detail = await up.text().catch(() => "");
      return res.status(500).json({ error: "upload failed", detail });
    }

    const uploaded = await up.json();
    const imageUrl = uploaded.urls?.get;
    if (!imageUrl) {
      return res.status(500).json({ error: "upload response invalid", uploaded });
    }

    // --- 3️⃣ Model-Version für flux-kontext-pro festlegen ---
    const MODEL_VERSION =
      "black-forest-labs/flux-kontext-pro:525e9f5e0a26c9b12dbcc69ad74246ad798e9dfb43a7379f06f3ddc5e679ff52";

    // --- 4️⃣ Prompt an Modell schicken ---
    const run = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: MODEL_VERSION,
        input: {
          prompt,
          image: imageUrl,
          mode: mode || "preview",
        },
      }),
    });

    if (!run.ok) {
      const detail = await run.text().catch(() => "");
      return res.status(500).json({ error: "replicate start failed", detail });
    }

    const runData = await run.json();

    // --- 5️⃣ Ergebnis abholen ---
    let status = runData.status;
    let output;
    let tries = 0;

    while (status !== "succeeded" && status !== "failed" && tries < 50) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await fetch(`https://api.replicate.com/v1/predictions/${runData.id}`, {
        headers: { Authorization: `Token ${REPLICATE_TOKEN}` },
      });
      const pollData = await poll.json();
      status = pollData.status;
      output = pollData.output;
      tries++;
    }

    if (status !== "succeeded") {
      return res.status(500).json({ error: "generation failed", status });
    }

    // --- 6️⃣ Rückgabe an Frontend ---
    return res.status(200).json({ imageUrl: output[0] });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({
      error: "Server crashed",
      detail: err?.message || String(err),
    });
  }
}
