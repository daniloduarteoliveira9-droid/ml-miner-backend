const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const ML_APP_ID    = process.env.ML_APP_ID;
const ML_SECRET    = process.env.ML_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

let _memToken = null;

function saveTokens(data) {
  _memToken = { ...data, saved_at: Date.now() };
  console.log("ACCESS_TOKEN:", data.access_token);
  console.log("REFRESH_TOKEN:", data.refresh_token);
}

function loadTokens() {
  if (_memToken) return _memToken;
  if (process.env.ML_ACCESS_TOKEN && process.env.ML_REFRESH_TOKEN) {
    return {
      access_token:  process.env.ML_ACCESS_TOKEN,
      refresh_token: process.env.ML_REFRESH_TOKEN,
      expires_in:    21600,
      saved_at:      0,
    };
  }
  return null;
}

async function getValidToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error("Não autenticado. Acesse /auth primeiro.");
  const ageMs = Date.now() - (tokens.saved_at || 0);
  const expiresMs = (tokens.expires_in || 21600) * 1000;
  if (ageMs < expiresMs - 60000) return tokens.access_token;
  const res = await axios.post(
    "https://api.mercadolibre.com/oauth/token",
    new URLSearchParams({ grant_type: "refresh_token", client_id: ML_APP_ID, client_secret: ML_SECRET, refresh_token: tokens.refresh_token }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  saveTokens(res.data);
  return res.data.access_token;
}

app.get("/", (req, res) => {
  const tokens = loadTokens();
  res.json({ status: "online", authenticated: !!tokens, message: tokens ? "✓ Autenticado" : "⚠ Acesse /auth" });
});

app.get("/auth", (req, res) => {
  res.redirect(`https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`);
});

app.get("/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "Código não recebido." });
  try {
    const response = await axios.post(
      "https://api.mercadolibre.com/oauth/token",
      new URLSearchParams({ grant_type: "authorization_code", client_id: ML_APP_ID, client_secret: ML_SECRET, code, redirect_uri: REDIRECT_URI }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    saveTokens(response.data);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#090;color:#fff">
      <h1>✓ Autenticado com sucesso!</h1>
      <p>user_id: ${response.data.user_id}</p>
      <hr style="margin:24px 0">
      <p><b>Adicione estas variáveis na Vercel (Settings → Environment Variables) e faça Redeploy:</b></p>
      <div style="background:#000;padding:16px;border-radius:8px;text-align:left;font-family:monospace;font-size:12px;max-width:800px;margin:16px auto;word-break:break-all">
        <p><b>ML_ACCESS_TOKEN</b> = ${response.data.access_token}</p>
        <p><b>ML_REFRESH_TOKEN</b> = ${response.data.refresh_token}</p>
      </div>
    </body></html>`);
  } catch (err) {
    res.status(500).json({ error: "Erro ao trocar código por token.", detail: err.response?.data });
  }
});

app.get("/search", async (req, res) => {
  let { q, limit = 20 } = req.query;
  if (!q) return res.status(400).json({ error: "Parâmetro q obrigatório." });

  // Limpa o nome: remove código interno, parênteses, texto após "Cód:", limita tamanho
  q = q
    .replace(/\(NÃO\s+\w+\)/gi, "")
    .replace(/Cód[:\s]+[\w\-]+/gi, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 80);

  if (!q) return res.status(400).json({ error: "Nome do produto inválido após limpeza." });

  try {
    const token = await getValidToken();
    const searchRes = await axios.get(`https://api.mercadolibre.com/sites/MLB/search`, {
      params: { q, limit },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    const items = (searchRes.data.results || []).filter(i => i.price > 0);

    // Visitas top 5 com timeout individual
    const enriched = await Promise.allSettled(
      items.slice(0, 5).map((item) =>
        axios.get(`https://api.mercadolibre.com/items/${item.id}/visits/time_window`, {
          params: { last: 30, unit: "day" },
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5000,
        }).then((r) => ({ id: item.id, visits: r.data })).catch(() => ({ id: item.id, visits: null }))
      )
    );
    const visitsMap = {};
    enriched.forEach((r) => { if (r.status === "fulfilled") visitsMap[r.value.id] = r.value.visits; });

    res.json({
      query: q,
      total_listings: searchRes.data.paging?.total || 0,
      items: items.map((item) => ({
        id: item.id, title: item.title, price: item.price, condition: item.condition,
        sold_quantity: item.sold_quantity || 0,
        free_shipping: item.shipping?.free_shipping || false,
        daily_visits: visitsMap[item.id] ? Math.round((visitsMap[item.id].total_visits || 0) / 30) : null,
        seller_reputation: item.seller?.seller_reputation?.level_id || null,
      })),
    });
  } catch (err) {
    console.error("Search error:", err.message, err.response?.data);
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Rodando em http://localhost:${PORT}`));
