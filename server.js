import express from "express";
import cors from "cors";
import multer from "multer";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const PDFParser = require("pdf2json");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const PROXY_SECRET   = process.env.PROXY_SECRET || "";
const MODEL          = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!GEMINI_API_KEY) { console.error("Brak GEMINI_API_KEY"); process.exit(1); }
if (!TAVILY_API_KEY) { console.error("Brak TAVILY_API_KEY"); process.exit(1); }

// ─── Auth helper ─────────────────────────────────────────────────────────────
function checkSecret(req, res) {
  const clientSecret = req.headers["x-proxy-secret"];
  if (PROXY_SECRET && clientSecret !== PROXY_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ─── Gemini helper ────────────────────────────────────────────────────────────
async function callGemini(prompt) {
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] })
    }
  );
  const data = await geminiRes.json();
  if (!geminiRes.ok) throw new Error(JSON.stringify(data));
  return data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") || "Brak odpowiedzi.";
}

// ─── GET / ────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "ai-proxy", model: MODEL });
});

// ─── POST /ask-page ───────────────────────────────────────────────────────────
app.post("/ask-page", async (req, res) => {
  try {
    if (!checkSecret(req, res)) return;
    const { question, pageText, title, url } = req.body || {};
    if (!question || !pageText) return res.status(400).json({ error: "Brak question albo pageText" });

    const prompt = `
Jesteś asystentem analizującym aktualnie otwartą stronę internetową.
Zasady:
- odpowiadaj po polsku,
- opieraj się tylko na treści przekazanej strony,
- jeśli czegoś nie ma w treści, napisz to wprost,
- na końcu dodaj krótką sekcję: Źródło:\n- Tytuł: ...\n- URL: ...

Tytuł strony: ${title || "brak"}
URL: ${url || "brak"}
Treść strony:
${String(pageText).slice(0, 20000)}
Pytanie użytkownika:
${question}`.trim();

    const answer = await callGemini(prompt);
    return res.json({ answer });
  } catch (error) {
    return res.status(500).json({ error: "Proxy error", details: String(error) });
  }
});

// ─── POST /search-web ─────────────────────────────────────────────────────────
app.post("/search-web", async (req, res) => {
  try {
    if (!checkSecret(req, res)) return;
    const { question } = req.body || {};
    if (!question) return res.status(400).json({ error: "Brak question" });

    const tavilyRes = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: question,
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
        include_raw_content: false
      })
    });

    const tavilyData = await tavilyRes.json();
    if (!tavilyRes.ok) return res.status(502).json({ error: "Tavily API error", details: tavilyData });

    const results = (tavilyData.results || []).map(r => ({
      title: r.title || "", url: r.url || "", snippet: r.content || ""
    }));

    if (results.length === 0) return res.json({ answer: "Nie znalazłem wyników.", sources: [] });

    const context = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n");

    const prompt = `
Jesteś asystentem wyszukującym informacje w internecie.
Zasady:
- odpowiadaj po polsku,
- opieraj się TYLKO na poniższych wynikach wyszukiwania,
- syntetyzuj informacje w spójną odpowiedź,
- NIE dodawaj sekcji "Źródło" — źródła są obsługiwane osobno.

Pytanie: ${question}
Wyniki wyszukiwania:
${context}`.trim();

    const answer = await callGemini(prompt);
    return res.json({ answer, sources: results });
  } catch (error) {
    return res.status(500).json({ error: "Proxy error", details: String(error) });
  }
});

// ─── POST /parse-pdf ──────────────────────────────────────────────────────────
app.post("/parse-pdf", upload.single("pdf"), async (req, res) => {
  try {
    if (!checkSecret(req, res)) return;

    if (!req.file) return res.status(400).json({ error: "Brak pliku PDF" });

    // pdf2json parsuje PDF z bufora
    const text = await new Promise((resolve, reject) => {
      const parser = new PDFParser(null, 1);
      parser.on("pdfParser_dataReady", () => resolve(parser.getRawTextContent()));
      parser.on("pdfParser_dataError", (err) => reject(new Error(String(err?.parserError || err))));
      parser.parseBuffer(req.file.buffer);
    });

    if (!text || !text.trim()) {
      return res.status(422).json({ error: "PDF nie zawiera tekstu (może być skanowany obraz)" });
    }

    const pages = Math.max(1, (text.match(/----------------Page/g) || []).length);

    return res.json({
      text: text.slice(0, 50000),
      pages,
      chars: text.length
    });

  } catch (error) {
    console.error("PDF parse error:", error);
    return res.status(500).json({ error: "Błąd parsowania PDF", details: String(error) });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`Proxy działa na http://${HOST}:${PORT}`);
});