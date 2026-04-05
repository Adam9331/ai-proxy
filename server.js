import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PROXY_SECRET = process.env.PROXY_SECRET || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!GEMINI_API_KEY) {
  console.error("Brak GEMINI_API_KEY");
  process.exit(1);
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "ai-proxy",
    model: MODEL
  });
});

app.post("/ask-page", async (req, res) => {
  try {
    const clientSecret = req.headers["x-proxy-secret"];

    if (PROXY_SECRET && clientSecret !== PROXY_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { question, pageText, title, url } = req.body || {};

    if (!question || !pageText) {
      return res.status(400).json({
        error: "Brak question albo pageText"
      });
    }

    const prompt = `
Jesteś asystentem analizującym stronę.

Zasady:
- odpowiadaj po polsku
- używaj tylko informacji z treści strony
- podawaj konkretne fragmenty jako źródła

FORMAT ODPOWIEDZI:

Odpowiedź:
...

Źródła:
- "fragment tekstu 1"
- "fragment tekstu 2"
- "fragment tekstu 3"

Treść strony:
${String(pageText).slice(0, 20000)}

Pytanie:
${question}
`.trim();

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ]
        })
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({
        error: "Gemini API error",
        details: data
      });
    }

    const answer =
      data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") ||
      "Brak odpowiedzi.";

    return res.json({ answer });
  } catch (error) {
    return res.status(500).json({
      error: "Proxy error",
      details: String(error)
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Proxy działa na http://${HOST}:${PORT}`);
});