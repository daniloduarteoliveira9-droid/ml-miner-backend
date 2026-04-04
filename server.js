const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors({
  origem: "*",
  métodos: ["GET", "POST", "OPTIONS"],
  cabeçalhos permitidos: ["Content-Type", "Authorization"],
}));
app.options("*", cors());

const ML_APP_ID = process.env.ML_APP_ID;
const ML_SECRET = process.env.ML_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

let _memToken = null;

função salvarTokens(dados) {
  _memToken = { ...dados, saved_at: Date.now() };
  console.log("ACCESS_TOKEN:", data.access_token);
  console.log("REFRESH_TOKEN:", data.refresh_token);
}

função carregarTokens() {
  se (_memToken) retorne _memToken;
  se (process.env.ML_ACCESS_TOKEN && process.env.ML_REFRESH_TOKEN) {
    retornar {
      token_de_acesso: process.env.ML_ACCESS_TOKEN,
      refresh_token: process.env.ML_REFRESH_TOKEN,
      expira_em: 21600,
      salvo_em: 0,
    };
  }
  retornar nulo;
}

função assíncrona refreshAccessToken(refreshToken) {
  const res = await axios.post(
    "https://api.mercadolibre.com/oauth/token",
    novo URLSearchParams({
      grant_type: "refresh_token",
      client_id: ML_APP_ID,
      client_secret: ML_SECRET,
      refresh_token: refreshToken,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  salvarTokens(res.dados);
  console.log("✓ Token renovado automaticamente");
  retornar res.data.access_token;
}

função assíncrona getValidToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error("Não autenticado. Acesse /auth primeiro.");

  // Se save_at=0 (veio de env vars), sempre renova via update_token
  se (tokens.saved_at === 0) {
    retornar await refreshAccessToken(tokens.refresh_token);
  }

  const ageMs = Date.now() - tokens.saved_at;
  const expiresMs = (tokens.expires_in || 21600) * 1000;

  // Token ainda
  se (idadeMs < expiraMs - 120000) retorne tokens.access_token;

  // Token expirado — renova
  retornar await refreshAccessToken(tokens.refresh_token);
}

função assíncrona callMLWithAutoRefresh(fn, tokens) {
  tentar {
    retornar await fn(tokens.access_token);
  } catch (erro) {
    se (err.response?.status === 403 || err.response?.status === 401) {
      console.log("403/401 detectado — renovando token...");
      const newToken = await refreshAccessToken(tokens.refresh_token);
      retornar await fn(novoToken);
    }
    lançar erro;
  }
}

app.get("/", (req, res) => {
  const tokens = loadTokens();
  res.json({ status: "online", autenticado: !!tokens, mensagem: tokens ? "✓ Autenticado" : "⚠ Acesse /auth" });
});

app.get("/auth", (req, res) => {
  res.redirect(`https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`);
});

app.get("/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ erro: "Código não recebido." });
  tentar {
    const resposta = await axios.post(
      "https://api.mercadolibre.com/oauth/token",
      novo URLSearchParams({ grant_type: "authorization_code", client_id: ML_APP_ID, client_secret: ML_SECRET, code, redirect_uri: REDIRECT_URI }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    salvarTokens(resposta.dados);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#090;color:#fff">
      <h1>✓ Autenticado com sucesso!</h1>
      <p>user_id: ${response.data.user_id}</p>
      <hr style="margin:24px 0">
      <p><b>Adicione essas variáveis ​​no Vercel (Settings → Environment Variables) e faça Redeploy:</b></p>
      <div style="background:#000;padding:16px;border-radius:8px;text-align:left;font-family:monospace;font-size:12px;max-width:800px;margin:16px auto;word-break:break-all">
        <p><b>ML_ACCESS_TOKEN</b> = ${response.data.access_token}</p>
        <p><b>ML_REFRESH_TOKEN</b> = ${response.data.refresh_token}</p>
      </div>
    </body></html>`);
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao trocar código por token.", detalhe: err.response?.data });
  }
});

app.get("/search", async (req, res) => {
  let { q, limit = 20 } = req.query;
  if (!q) return res.status(400).json({ erro: "Parâmetro q obrigatório." });

  q = q
    .replace(/\(NÃO\s+\w+\)/gi, "")
    .replace(/Cód[:\s]+[\w\-]+/gi, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s{2,}/g, ​​" ")
    .aparar()
    .slice(0, 80);

  if (!q) return res.status(400).json({ erro: "Nome inválido." });

  tentar {
    const tokens = loadTokens();
    if (!tokens) throw new Error("Não autenticado.");

    const token = await getValidToken();

    const searchRes = await callMLWithAutoRefresh(
      (tk) => axios.get(`https://api.mercadolibre.com/sites/MLB/search`, {
        parâmetros: { q, limite },
        cabeçalhos: { Authorization: `Bearer ${tk}` },
        tempo limite: 10000,
      }),
      fichas
    );

    const items = (searchRes.data.results || []).filter(i => i.price > 0);

    const enriquecido = await Promise.allSettled(
      itens.slice(0, 5).map((item) =>
        axios.get(`https://api.mercadolibre.com/items/${item.id}/visits/time_window`, {
          parâmetros: { último: 30, unidade: "dia" },
          cabeçalhos: { Authorization: `Bearer ${token}` },
          tempo limite: 5000,
        }).then((r) => ({ id: item.id, visits: r.data })).catch(() => ({ id: item.id, visits: null }))
      )
    );
    const visitsMap = {};
    enriched.forEach((r) => { if (r.status === "fulfilled") visitsMap[r.value.id] = r.value.visits; });

    res.json({
      consulta: q,
      total_listings: searchRes.data.paging?.total || 0,
      itens: itens.map((item) => ({
        id: item.id, título: item.title, preço: item.price, condição: item.condition,
        quantidade_vendida: item.quantidade_vendida || 0,
        frete_grátis: item.frete?.frete_grátis || falso,
        daily_visits: visitsMap[item.id] ? Math.round((visitsMap[item.id].total_visits || 0) / 30) : null,
        seller_reputation: item.seller?.seller_reputation?.level_id || null,
      })),
    });
  } catch (erro) {
    console.error("Erro na pesquisa:", err.message, err.response?.data);
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Rodando em http://localhost:${PORT}`));
