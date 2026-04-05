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
Jesteś asystentem analizującym aktualnie otwartą stronę internetową.

Zasady:
- odpowiadaj po polsku,
- używaj wyłącznie informacji z tekstu strony,
- cytaty muszą być dokładnymi fragmentami 1:1 z tekstu strony,
- nie parafrazuj cytatów,
- zwróć WYŁĄCZNIE poprawny JSON.

Format JSON:
{
  "answer": "krótka odpowiedź po polsku",
  "quotes": [
    "dokładny cytat 1 ze strony",
    "dokładny cytat 2 ze strony",
    "dokładny cytat 3 ze strony"
  ]
}

Tytuł strony: ${title || "brak"}
URL: ${url || "brak"}

Tekst strony:
${String(pageText).slice(0, 20000)}

Pytanie użytkownika:
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

    const raw =
      data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") || "";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return res.status(500).json({
          error: "Model nie zwrócił poprawnego JSON",
          raw
        });
      }
      parsed = JSON.parse(jsonMatch[0]);
    }

    return res.json({
      answer: parsed.answer || "Brak odpowiedzi.",
      quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
      title: title || "",
      url: url || ""
    });
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