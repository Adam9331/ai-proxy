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
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const PROXY_SECRET   = process.env.PROXY_SECRET || "";
const MODEL          = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!GEMINI_API_KEY) { console.error("Brak GEMINI_API_KEY"); process.exit(1); }
if (!TAVILY_API_KEY) { console.error("Brak TAVILY_API_KEY"); process.exit(1); }

// ─── OpenRouter helper ────────────────────────────────────────────────────────
async function callOpenRouter(prompt, model = "perplexity/sonar-reasoning") {
  if (!OPENROUTER_API_KEY) throw new Error("Brak klucza OPENROUTER_API_KEY");
  
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/lek-adam/ai-sidebar", // Opcjonalne
      "X-Title": "AI Sidebar Custom"
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: "user", content: prompt }]
    })
  });
  
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return {
    answer: data.choices[0].message.content,
    // OpenRouter dla modeli Sonar często zwraca źródła w polu 'citations'
    sources: data.citations || [] 
  };
}

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
async function callGemini(prompt, useSearch = false) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  };

  if (useSearch) {
    body.tools = [{ google_search: {} }];
  }

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify(body)
    }
  );
  
  const data = await geminiRes.json();
  if (!geminiRes.ok) throw new Error(JSON.stringify(data));

  const candidate = data?.candidates?.[0];
  const answer = candidate?.content?.parts?.map(p => p.text).join("\n") || "Brak odpowiedzi.";
  
  // Wyciąganie źródeł z Google Search Grounding
  let sources = [];
  if (useSearch && candidate?.groundingMetadata?.groundingChunks) {
    candidate.groundingMetadata.groundingChunks.forEach(chunk => {
      let title = chunk?.web?.title || "";
      const url = chunk?.web?.uri || "";
      const snippet = chunk?.web?.snippet || chunk?.web?.content || ""; 
      
      if (!url) return;

      // Jeśli tytuł jest pusty lub techniczny ("Vertex", "Search", "Google"), upiększ go
      const technicalTerms = ["vertex", "search", "google", "grounding", "cloud"];
      const isTechnical = technicalTerms.some(term => title.toLowerCase().includes(term));
      
      if (!title || isTechnical) {
        try {
          const domain = new URL(url).hostname.replace("www.", "");
          // Jeśli mamy techniczny tytuł, używamy domeny
          title = domain.charAt(0).toUpperCase() + domain.slice(1);
        } catch {
          if (!title) title = "Źródło";
        }
      }

      sources.push({ title, url, snippet });
    });
  }

  return { answer, sources };
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

    const isPdf = url && url.startsWith("pdf://");

    const prompt = isPdf ? `
Jesteś asystentem analizującym treść dokumentu PDF.
Zasady:
- odpowiadaj po polsku,
- opieraj się WYŁĄCZNIE na treści przekazanego dokumentu,
- jeśli informacja jest w dokumencie — znajdź ją i podaj dokładnie,
- jeśli naprawdę jej nie ma — napisz to wprost.

Na końcu odpowiedzi dodaj sekcję w DOKŁADNIE tym formacie:
CYTATY: "dokładny fragment 1":strona|"dokładny fragment 2":strona|"dokładny fragment 3":strona

Zasady dla cytatów:
- max 3 cytaty
- każdy cytat to 4-8 kolejnych słów skopiowanych DOSŁOWNIE z tekstu dokumentu
- cytaty muszą być fragmentami które FAKTYCZNIE zawierają odpowiedź
- dodaj po dwukropku numer strony, na której znajduje się ten cytat (szukaj markerów --- Strona X --- w tekście)
- nie używaj wielokropków ani skrótów wewnątrz cytatu
- oddzielaj kolejne cytaty znakiem |

Nazwa dokumentu: ${title || "brak"}

Treść dokumentu PDF:
${String(pageText).slice(0, 40000)}

Pytanie:
${question}`.trim() : `
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

    const { answer, sources: groundingSources } = await callGemini(prompt);
    const raw = answer;

    // Dla PDF — wyciągnij cytaty i zbuduj text fragment linki
    if (isPdf) {
      const cytatsMatch = raw.match(/CYTATY:\s*([^\n\r]+)/i);
      let quotes = [];
      
      if (cytatsMatch) {
        const parts = cytatsMatch[1].split("|");
        for (const part of parts) {
          const splitPart = part.split(":");
          if (splitPart.length >= 2) {
             const pageNumMatch = splitPart[splitPart.length - 1].match(/\d+/);
             const quoteText = splitPart.slice(0, -1).join(":").replace(/^"|"$/g, "").trim();
             if (quoteText.length > 5) {
                quotes.push({
                   quote: quoteText,
                   page: pageNumMatch ? parseInt(pageNumMatch[0]) : 1
                });
             }
          } else {
             const quoteText = part.replace(/^"|"$/g, "").trim();
             if (quoteText.length > 5) quotes.push({ quote: quoteText, page: 1 });
          }
        }
        quotes = quotes.slice(0, 3);
      }

      const cleanAnswer = raw.replace(/[\n\r]*CYTATY:[^\n\r]*/im, "").trim();
      const pdfFileName = url.replace("pdf://", "");

      const sources = quotes.map((q, i) => ({
        title: q.quote,
        quote: q.quote,
        page: q.page,
        fileName: pdfFileName
      }));

      return res.json({ answer: cleanAnswer, sources });
    }

    return res.json({ answer: raw });
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

    const prompt = `
Jesteś asystentem wyszukującym informacje w internecie przy użyciu Google Search.
Zasady:
- odpowiadaj po polsku,
- syntetyzuj informacje w spójną i precyzyjną odpowiedź na podstawie znalezionych źródeł,
- na samym końcu swojej odpowiedzi dodaj sekcję "**Wykorzystane materiały:**", w której w jednym lub dwóch zdaniach opisz, co dokładnie zawierają poszczególne przypisy/numery źródeł, na które się powołujesz (np. podaj ich rzeczywiste tytuły i czego dotyczą),
- NIE dodawaj sekcji z samymi linkami URL, ponieważ interfejs wyświetli je automatycznie pod Twoją odpowiedzią.

Pytanie: ${question}`;

    const { answer, sources } = await callGemini(prompt, true);
    
    // Formatuje źródła tak, aby pasowały do frontendu. 
    const formattedSources = sources.map(s => ({
      title: s.title,
      url: s.url,
      snippet: s.snippet || ""
    }));

    return res.json({ answer: answer.trim(), sources: formattedSources });
  } catch (error) {
    console.error("Gemini Search Error:", error);
    return res.status(500).json({ error: "Proxy error", details: String(error) });
  }
});

// ─── POST /search-super (OpenRouter / Perplexity) ─────────────────────────────
app.post("/search-super", async (req, res) => {
  try {
    if (!checkSecret(req, res)) return;
    const { question } = req.body || {};
    if (!question) return res.status(400).json({ error: "Brak pytania" });

    // Używamy Perplexity Sonar (model natywnie obsługujący wyszukiwanie) przez OpenRouter
    const result = await callOpenRouter(question, "perplexity/sonar");
    
    // OpenRouter dla modeli Sonar często zwraca listę cytatów jako array URL-i w polu 'citations'
    // Jeśli nie ma, zwróć pustą tablicę.
    const sources = (result.sources || []).map((url, i) => ({
      title: `Źródło [${i + 1}]`,
      url: url,
      snippet: ""
    }));

    return res.json({ answer: result.answer, sources });
  } catch (error) {
    console.error("OpenRouter Error:", error);
    return res.status(500).json({ error: "OpenRouter Error: " + (error.message || String(error)) });
  }
});

// ─── POST /chat-gpt (OpenRouter / GPT-4o-mini / Medical Expert) ───────────────
app.post("/chat-gpt", async (req, res) => {
  try {
    if (!checkSecret(req, res)) return;
    const { question } = req.body || {};
    if (!question) return res.status(400).json({ error: "Brak pytania" });

    const medicalPrompt = `Jesteś profesjonalnym asystentem medycznym. 
Zasady:
- odpowiadaj zawsze po polsku,
- używaj profesjonalnej terminologii medycznej,
- bądź rzeczowy i konkretny,
- jeśli pytanie dotyczy dawkowania lub diagnostyki, opieraj się na aktualnych wytycznych (EBM),
- zachowaj profesjonalny ton.

Pytanie użytkownika: ${question}`;

    const result = await callOpenRouter(medicalPrompt, "openai/gpt-4o-mini");
    return res.json({ answer: result.answer, sources: [] });
  } catch (error) {
    console.error("GPT Error:", error);
    return res.status(500).json({ error: "GPT Error: " + (error.message || String(error)) });
  }
});

// ─── POST /ask-pdf-claude (OpenRouter / Claude 3.5 Haiku) ─────────────────────
app.post("/ask-pdf-claude", async (req, res) => {
  try {
    if (!checkSecret(req, res)) return;
    const { question, pageText, title, url } = req.body || {};
    if (!question || !pageText) return res.status(400).json({ error: "Brak danych" });

    const prompt = `
Jesteś asystentem Claude analizującym dokument PDF.
Zasady:
- odpowiadaj po polsku,
- opieraj się WYŁĄCZNIE na treści przekazanego dokumentu,
- jeśli informacja jest w dokumencie — znajdź ją i podaj dokładnie,
- na końcu odpowiedzi dodaj sekcję w DOKŁADNIE tym formacie:
CYTATY: "dokładny fragment 1":strona|"dokładny fragment 2":strona|"dokładny fragment 3":strona

Zasady dla cytatów:
- każdy cytat to 4-8 kolejnych słów skopiowanych DOSŁOWNIE z tekstu dokumentu
- dodaj po dwukropku numer strony, na której znajduje się ten cytat (szukaj markerów --- Strona X --- w tekście)
- oddzielaj kolejne cytaty znakiem |

Nazwa dokumentu: ${title || "brak"}

Treść dokumentu PDF:
${String(pageText).slice(0, 45000)}

Pytanie: ${question}`.trim();

    const result = await callOpenRouter(prompt, "anthropic/claude-3.5-haiku");
    const raw = result.answer || "";

    const cytatsMatch = raw.match(/CYTATY:\s*([^\n\r]+)/i);
    let quotes = [];
    if (cytatsMatch) {
      const parts = cytatsMatch[1].split("|");
      for (const part of parts) {
        const splitPart = part.split(":");
        if (splitPart.length >= 2) {
          const pageNumMatch = splitPart[splitPart.length - 1].match(/\d+/);
          const quoteText = splitPart.slice(0, -1).join(":").replace(/^"|"$/g, "").trim();
          if (quoteText.length > 5) {
            quotes.push({ quote: quoteText, page: pageNumMatch ? parseInt(pageNumMatch[0]) : 1 });
          }
        } else {
          const quoteText = part.replace(/^"|"$/g, "").trim();
          if (quoteText.length > 5) quotes.push({ quote: quoteText, page: 1 });
        }
      }
    }

    const answer = raw.replace(/[\n\r]*CYTATY:[^\n\r]*/im, "").trim();
    const sources = quotes.slice(0, 3).map(q => ({ title: q.quote, quote: q.quote, page: q.page }));
    return res.json({ answer, sources });
  } catch (error) {
    console.error("Claude PDF Error:", error);
    return res.status(500).json({ error: "Claude PDF Error: " + (error.message || String(error)) });
  }
});

// ─── POST /parse-pdf ──────────────────────────────────────────────────────────
app.post("/parse-pdf", upload.single("pdf"), async (req, res) => {
  try {
    if (!checkSecret(req, res)) return;

    if (!req.file) return res.status(400).json({ error: "Brak pliku PDF" });

    // pdf2json parsuje PDF z bufora
    const rawText = await new Promise((resolve, reject) => {
      const parser = new PDFParser(null, 1);
      parser.on("pdfParser_dataReady", () => resolve(parser.getRawTextContent()));
      parser.on("pdfParser_dataError", (err) => reject(new Error(String(err?.parserError || err))));
      parser.parseBuffer(req.file.buffer);
    });

    if (!rawText || !rawText.trim()) {
      return res.status(422).json({ error: "PDF nie zawiera tekstu (może być skanowany obraz)" });
    }

    // Policz strony
    const pages = Math.max(1, (rawText.match(/----------------Page/g) || []).length);

    // Wyczyść tekst — usuń śmieci z pdf2json, zachowaj czytelny tekst
    const text = rawText
      .replace(/----------------Page \(\d+\) Break----------------/g, "\n\n--- Strona $& ---\n\n")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]{3,}/g, " ")        // wielokrotne spacje → jedna
      .replace(/\n{4,}/g, "\n\n\n")   // wielokrotne puste linie → max 3
      .trim();

    return res.json({
      text: text.slice(0, 60000),
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