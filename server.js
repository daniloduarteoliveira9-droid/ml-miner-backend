const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors()); // Permite chamadas do artifact do Claude

// ── Configurações ─────────────────────────────────────────
const ML_APP_ID     = process.env.ML_APP_ID;
const ML_SECRET     = process.env.ML_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI; // ex: https://seu-app.vercel.app/callback
const TOKEN_FILE    = path.join("/tmp", "ml_tokens.json"); // /tmp funciona na Vercel

// ── Helpers de token ──────────────────────────────────────
function saveTokens(data) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...data, saved_at: Date.now() }));
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE));
  } catch {}
  return null;
}

async function getValidToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error("Não autenticado. Acesse /auth primeiro.");

  const ageMs = Date.now() - tokens.saved_at;
  const expiresInMs = (tokens.expires_in || 21600) * 1000;

  // Ainda válido
  if (ageMs < expiresInMs - 60000) return tokens.access_token;

  // Expirou — renovar com refresh_token
  console.log("Token expirado, renovando...");
  const res = await axios.post(
    "https://api.mercadolibre.com/oauth/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ML_APP_ID,
      client_secret: ML_SECRET,
      refresh_token: tokens.refresh_token,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  saveTokens(res.data);
  return res.data.access_token;
}

// ── ROTAS ─────────────────────────────────────────────────

// GET /  →  Status geral
app.get("/", (req, res) => {
  const tokens = loadTokens();
  res.json({
    status: "online",
    authenticated: !!tokens,
    message: tokens ? "✓ Autenticado com Mercado Livre" : "⚠ Acesse /auth para autenticar",
  });
});

// GET /auth  →  Redireciona para o ML para autorização
app.get("/auth", (req, res) => {
  const url =
    `https://auth.mercadolivre.com.br/authorization` +
    `?response_type=code` +
    `&client_id=${ML_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.redirect(url);
});

// GET /callback  →  ML redireciona aqui com o código
app.get("/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "Código não recebido." });

  try {
    const response = await axios.post(
      "https://api.mercadolibre.com/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: ML_APP_ID,
        client_secret: ML_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    saveTokens(response.data);
    console.log("✓ Autenticado com sucesso! user_id:", response.data.user_id);

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f0;color:#000">
        <h1>✓ Autenticado com sucesso!</h1>
        <p>user_id: ${response.data.user_id}</p>
        <p>Pode fechar esta janela e voltar ao ML Miner.</p>
      </body></html>
    `);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao trocar código por token.", detail: err.response?.data });
  }
});

// GET /search?q=produto  →  Busca no ML autenticada com dados ricos
app.get("/search", async (req, res) => {
  const { q, limit = 20 } = req.query;
  if (!q) return res.status(400).json({ error: "Parâmetro q obrigatório." });

  try {
    const token = await getValidToken();

    // Busca principal
    const searchRes = await axios.get(
      `https://api.mercadolibre.com/sites/MLB/search`,
      {
        params: { q, limit, condition: "new" },
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const items = searchRes.data.results || [];

    // Para os top 5 itens, busca dados de visita e tendência
    const enriched = await Promise.allSettled(
      items.slice(0, 5).map((item) =>
        axios
          .get(`https://api.mercadolibre.com/items/${item.id}/visits/time_window`, {
            params: { last: 30, unit: "day" },
            headers: { Authorization: `Bearer ${token}` },
          })
          .then((r) => ({ id: item.id, visits: r.data }))
          .catch(() => ({ id: item.id, visits: null }))
      )
    );

    const visitsMap = {};
    enriched.forEach((r) => {
      if (r.status === "fulfilled") visitsMap[r.value.id] = r.value.visits;
    });

    // Monta resposta enriquecida
    const enrichedItems = items.map((item) => ({
      id: item.id,
      title: item.title,
      price: item.price,
      condition: item.condition,
      sold_quantity: item.sold_quantity,
      available_quantity: item.available_quantity,
      free_shipping: item.shipping?.free_shipping || false,
      daily_visits: visitsMap[item.id]
        ? Math.round(
            (visitsMap[item.id].total_visits || 0) /
              (visitsMap[item.id].date_to ? 30 : 1)
          )
        : null,
      seller_reputation: item.seller?.seller_reputation?.level_id || null,
      catalog_product_id: item.catalog_product_id || null,
    }));

    res.json({
      query: q,
      total_listings: searchRes.data.paging?.total || 0,
      items: enrichedItems,
    });
  } catch (err) {
    const msg = err.message || "Erro na busca";
    res.status(500).json({ error: msg, detail: err.response?.data });
  }
});

// GET /trends  →  Tendências por categoria
app.get("/trends", async (req, res) => {
  try {
    const token = await getValidToken();
    const r = await axios.get(
      "https://api.mercadolibre.com/trends/MLB",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 ML Miner Backend rodando em http://localhost:${PORT}\n`));
