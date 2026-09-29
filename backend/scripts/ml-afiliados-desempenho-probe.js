#!/usr/bin/env node
// SONDA: de onde o painel de afiliados do ML tira os números de desempenho, e dá
// pra buscar esses números SEM navegador?
//
// Por que a pergunta existe. A task 2 pede o desempenho de afiliado (cliques,
// vendas, comissão) "pela API, nada de scraping de página". O ML não tem API
// pública de afiliados — a api.mercadolibre.com com OAuth só cobre vendedor. O
// que existe são os endpoints JSON internos que o próprio painel /afiliados
// chama, do mesmo tipo do createLink que o sistema já usa pra gerar link.
//
// Só que "endpoint interno" tem dois comportamentos conhecidos aqui dentro:
//   - o createLink aceita um fetch cru só com o cookie (scraping/affiliate.js);
//   - o /affiliate-program/api/hub/search recusa (GET 404, POST 403 — falta o
//     CSRF e os cabeçalhos que o navegador monta; scraping/ml-hub.js).
// Não se sabe de que lado caem os endpoints de relatório, e isso decide tudo: do
// lado do createLink a produção é um fetch leve; do lado do Hub ela precisaria de
// um Chrome por usuário a cada rodada, e aí é outra conversa.
//
// O que a sonda faz:
//   1. Abre o painel /afiliados logado com o cookie do USUÁRIO, visita as páginas
//      do menu e grava toda resposta JSON que a página buscar sozinha.
//   2. Refaz cada chamada de leitura com fetch cru, em variantes cada vez mais
//      completas, e diz qual é a mínima que funciona.
//
// Uso:
//   node scripts/ml-afiliados-desempenho-probe.js --user <email|userId>
//   node scripts/ml-afiliados-desempenho-probe.js --cookie-env MINHA_VAR
//   node scripts/ml-afiliados-desempenho-probe.js --user <email> --pagina /afiliados/xyz
//
// `--pagina` (repetível) acrescenta caminhos à lista de páginas visitadas, pra
// quando o menu esconder alguma atrás de um clique. Com `--so-paginas`, a sonda
// visita SÓ essas (sem varrer o menu) — pra olhar de novo uma página específica.
// `--clicar "<texto>"` (repetível) clica, em cada página visitada, no elemento com
// esse texto (uma aba, um filtro) e grava o que a página buscar depois do clique.
//
// De cada página ficam o texto visível (`pagina-NN.txt`) e o estado que ela traz
// embutido (`estado-NN.json`, com token e sessão redigidos): é por eles que se
// descobre o que o painel mostra sem ter buscado por XHR.
//
// Só LÊ: não escreve no banco, não grava o cookie (nem CSRF) em arquivo nenhum e
// só refaz POST cuja URL tem cara de consulta — nunca de ação.

require("../config/loadEnv");
const fs = require("fs");
const path = require("path");

const BASE = "https://www.mercadolivre.com.br";
const START_URL = `${BASE}/afiliados`;
const OUT_BASE = path.join(__dirname, "..", "logs", "ml-afiliados");

// Páginas que valem a tentativa mesmo que o menu não as mostre. Se não existirem,
// o ML devolve uma página de erro e a sonda só anota — não custa nada.
const PAGINAS_CANDIDATAS = [
  "/afiliados/dashboard",
  "/afiliados/desempenho",
  "/afiliados/relatorios",
  "/afiliados/ganhos",
  "/afiliados/metricas",
];

const MAX_PAGINAS = 14;
const MAX_REPLAYS = 40;
const MAX_BODY_CHARS = 200 * 1024;
const MAX_POSTDATA_CHARS = 8 * 1024;
const REPLAY_PAUSE_MS = 400;
const REPLAY_TIMEOUT_MS = 20000;
const SETTLE_MS = 2500;

// Nada disso é dado de desempenho: é telemetria, fonte, imagem, config de tela.
const RUIDO_RE = /melidata|\/tracks?\b|\/analytics|hotjar|google|doubleclick|facebook|tiktok|frontend-assets|\/static\/|\.(js|css|png|jpe?g|webp|svg|woff2?)(\?|$)|\/navigation\/|\/cookies-preferences|\/nav-header|\/notifications\/count/i;

// Cabeçalhos que carregam sessão. Ficam na memória pro replay e NUNCA vão pro disco.
const SENSIVEIS = new Set(["cookie", "set-cookie", "authorization", "x-csrf-token", "csrf-token", "x-xsrf-token", "x-newrelic-id"]);

// Cabeçalhos que o fetch do Node não deixa (ou não faz sentido) repassar.
const NAO_REPASSA = new Set(["host", "connection", "content-length", "accept-encoding", "cookie"]);

// POST só se replica quando a URL tem cara de consulta, e nunca de ação.
const POST_LEITURA_RE = /search|report|relatorio|metric|dashboard|summary|resumo|list|query|graphql|performance|desempenho|earning|ganho|\bstats?\b|balance|saldo|chart/i;
const POST_ACAO_RE = /create|delete|remove|update|save|send|accept|terms|mark|read-all|opt-?in|opt-?out|enroll|subscribe/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MAX_TEXTO_CHARS = 30000;
const CHAVE_SENSIVEL_RE = /csrf|token|session|secret|password|cookie/i;

// O texto visível e o estado embutido da página, pra ver o que ela mostra além do
// que buscou por XHR. O estado passa pela redação antes de ir pro disco.
async function retrataPagina(page, salva, n) {
  const { texto, estados } = await page.evaluate((maxChars) => {
    const globais = ["__PRELOADED_STATE__", "__INITIAL_STATE__", "__NEXT_DATA__", "__STATE__"];
    const estados = {};
    for (const g of globais) if (window[g]) estados[g] = window[g];
    // Estado serializado num <script type="application/json"> também conta.
    document.querySelectorAll('script[type="application/json"]').forEach((el, i) => {
      if ((el.textContent || "").length > 200) estados[`script-json-${el.id || i}`] = el.textContent;
    });
    return { texto: (document.body?.innerText || "").slice(0, maxChars), estados };
  }, MAX_TEXTO_CHARS).catch(() => ({ texto: "", estados: {} }));

  const redigeChaves = (v) => {
    if (Array.isArray(v)) return v.map(redigeChaves);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = CHAVE_SENSIVEL_RE.test(k) ? "[redigido]" : redigeChaves(x);
      return out;
    }
    return v;
  };
  for (const k of Object.keys(estados)) {
    if (typeof estados[k] === "string") {
      try { estados[k] = JSON.parse(estados[k]); } catch { /* fica como texto */ }
    }
    estados[k] = redigeChaves(estados[k]);
  }

  const id = String(n).padStart(2, "0");
  salva(`pagina-${id}.txt`, texto);
  if (Object.keys(estados).length) salva(`estado-${id}.json`, estados);
  return { chavesDeEstado: Object.keys(estados), textoChars: texto.length };
}

function redige(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SENSIVEIS.has(k.toLowerCase()) ? "[redigido]" : v;
  return out;
}

function ehML(url) {
  try { return /(^|\.)mercadoli(vre|bre)\.com(\.br)?$/i.test(new URL(url).hostname); }
  catch { return false; }
}

// Chave do endpoint pro replay: método + URL sem os parâmetros que só servem de
// cache-buster. Duas chamadas iguais do painel viram um replay só.
function chaveEndpoint(method, url) {
  try {
    const u = new URL(url);
    for (const p of ["_", "t", "ts", "timestamp", "cacheBuster"]) u.searchParams.delete(p);
    return `${method} ${u.toString()}`;
  } catch { return `${method} ${url}`; }
}

function temCaraDeDesempenho(texto) {
  return /click|clique|commission|comiss|earning|ganho|conversion|convers|orders?\b|vendas?|sales|gmv|revenue|faturamento|amount|valor/i.test(texto);
}

async function resolveUsuario(arg) {
  if (!arg) return null;
  if (arg.includes("@")) {
    const u = await require("../auth").findByEmail(arg);
    return u?.id || null;
  }
  return arg;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
  };
  const flags = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));

  let cookie = null;
  let tag = null;
  if (flag("--cookie-env")) {
    cookie = process.env[flag("--cookie-env")] || null;
  } else {
    await require("../config").warmup();
    const affiliate = require("../scraping/affiliate");
    await affiliate.warmup();
    const userId = await resolveUsuario(flag("--user"));
    if (!userId) {
      console.error("uso: node scripts/ml-afiliados-desempenho-probe.js --user <email|userId>");
      console.error("     (ou --cookie-env <VAR> com o cookie numa variável de ambiente)");
      process.exit(1);
    }
    ({ cookie, tag } = affiliate.readMLConfig(userId));
    console.log(`[sonda] usuário ${userId} · tag ${tag || "—"}`);
  }
  if (!cookie) {
    console.error("[sonda] sem cookie do ML — cole em Mercado Livre › Afiliados (ou use --cookie-env).");
    process.exit(1);
  }

  const out = path.join(OUT_BASE, new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(out, { recursive: true });
  const salva = (nome, conteudo) => fs.writeFileSync(path.join(out, nome), typeof conteudo === "string" ? conteudo : JSON.stringify(conteudo, null, 2));
  console.log(`[sonda] saída: ${out}`);

  // ── Passo 1: o que o painel busca sozinho ─────────────────────────────────
  const { withMLSessionPage, snapshotPage, classifyMLWall, clickByText } = require("../scraping/ml-session-page");
  const { autoScroll } = require("../scraping/scraper");

  const capturas = [];          // o que vai pro disco (redigido)
  const paraReplay = new Map(); // chave → { method, url, headers (crus), postData, referer }
  let paginaAtual = START_URL;

  function escuta(page) {
    page.on("response", async (res) => {
      const url = res.url();
      if (!ehML(url) || RUIDO_RE.test(url)) return;
      const ct = String(res.headers()["content-type"] || "");
      if (!/json/i.test(ct)) return;
      const req = res.request();
      if (req.resourceType() === "document") return;

      let body = null;
      try { body = await res.text(); } catch { /* corpo descartado pelo Chrome */ }
      const method = req.method();
      const postData = req.postData() || null;

      const n = capturas.length + 1;
      const registro = {
        n,
        pagina: paginaAtual,
        method,
        url,
        status: res.status(),
        requestHeaders: redige(req.headers()),
        postData: postData ? postData.slice(0, MAX_POSTDATA_CHARS) : null,
        responseHeaders: redige(res.headers()),
        bodyChars: body ? body.length : 0,
        pareceDesempenho: temCaraDeDesempenho(`${url}\n${(body || "").slice(0, 20000)}`),
        body: body ? body.slice(0, MAX_BODY_CHARS) : null,
      };
      capturas.push(registro);
      salva(`xhr-${String(n).padStart(2, "0")}.json`, registro);

      const chave = chaveEndpoint(method, url);
      if (!paraReplay.has(chave)) {
        paraReplay.set(chave, { n, method, url, headers: req.headers(), postData, referer: paginaAtual });
      }
    });
  }

  const paginas = [];
  let browser = null;
  let cookiesDoNavegador = null;
  let csrfDaPagina = null;
  try {
    const sessao = await withMLSessionPage(cookie, START_URL, escuta, { scrollAfterLoad: true });
    browser = sessao.browser;
    const { page } = sessao;
    await sleep(SETTLE_MS);

    const muro = classifyMLWall({ finalUrl: sessao.finalUrl, bodyText: sessao.bodyText });
    const retrato = await retrataPagina(page, salva, 0);
    paginas.push({ url: START_URL, finalUrl: sessao.finalUrl, title: sessao.title, muro: muro?.status || null, ...retrato });
    console.log(`[sonda] ${START_URL} → ${sessao.finalUrl}${muro ? ` · MURO: ${muro.status}` : ""}`);
    if (muro) {
      salva("pagina-inicial.txt", sessao.bodyText);
      return finaliza(out, salva, { etapa: "abrir-painel", veredito: `muro-${muro.status}`, motivo: muro.reason, paginas });
    }

    // Os links do menu do painel. O ML monta o menu no cliente, então é depois do
    // goto (e da rolagem) que eles existem no DOM.
    const doMenu = await page.$$eval("a[href]", (as) => as.map(a => a.href)).catch(() => []);
    const extras = flags("--pagina").map(p => (p.startsWith("http") ? p : `${BASE}${p}`));
    const soPaginas = args.includes("--so-paginas");
    const fila = [...new Set(soPaginas ? extras : [
      ...doMenu.filter(h => /^https:\/\/www\.mercadolivre\.com\.br\/afiliados(\/|$|\?)/i.test(h)).map(h => h.split("#")[0]),
      ...PAGINAS_CANDIDATAS.map(p => `${BASE}${p}`),
      ...extras,
    ])].filter(u => u !== START_URL && !/\/afiliados\/hub(\/|$|\?)/i.test(u)).slice(0, MAX_PAGINAS);
    console.log(`[sonda] ${fila.length} página(s) do painel pra visitar`);

    for (const url of fila) {
      paginaAtual = url;
      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
        await autoScroll(page);
        await sleep(SETTLE_MS);
        const snap = await snapshotPage(page);
        const muroAqui = classifyMLWall({ finalUrl: page.url(), bodyText: snap.bodyText });
        const retratoAqui = await retrataPagina(page, salva, paginas.length);
        paginas.push({ url, finalUrl: page.url(), title: snap.title, muro: muroAqui?.status || null, ...retratoAqui });
        console.log(`[sonda] ${url} → ${page.url()}${muroAqui ? ` · MURO: ${muroAqui.status}` : ""}`);
        if (muroAqui) break;

        for (const texto of flags("--clicar")) {
          paginaAtual = `${url} [clique: ${texto}]`;
          const clicou = await clickByText(page, texto).catch(() => false);
          await sleep(SETTLE_MS);
          const retratoClique = clicou ? await retrataPagina(page, salva, paginas.length) : {};
          paginas.push({ url: paginaAtual, clicou, ...retratoClique });
          console.log(`[sonda]   clique em "${texto}": ${clicou ? "ok" : "não achou"}`);
        }
      } catch (err) {
        paginas.push({ url, erro: err.message });
        console.warn(`[sonda] ${url} falhou: ${err.message}`);
      }
    }

    cookiesDoNavegador = (await page.cookies().catch(() => []))
      .filter(c => /mercadoli(vre|bre)/i.test(c.domain))
      .map(c => `${c.name}=${c.value}`).join("; ");
    csrfDaPagina = await page.$eval('meta[name="csrf-token"]', m => m.content).catch(() => null);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  salva("index.json", {
    paginas,
    capturas: capturas.map(({ body, requestHeaders, responseHeaders, postData, ...resto }) => resto),
  });
  console.log(`[sonda] ${capturas.length} resposta(s) JSON capturada(s), ${capturas.filter(c => c.pareceDesempenho).length} com cara de desempenho`);

  // ── Passo 2: dá pra buscar sem navegador? ─────────────────────────────────
  const { UA } = require("../scraping/scraper");
  const vereditos = [];
  const endpoints = [...paraReplay.values()].slice(0, MAX_REPLAYS);

  for (const ep of endpoints) {
    if (ep.method !== "GET" && (!POST_LEITURA_RE.test(ep.url) || POST_ACAO_RE.test(ep.url))) {
      vereditos.push({ n: ep.n, method: ep.method, url: ep.url, veredito: "nao-testado", motivo: "POST com cara de ação" });
      continue;
    }

    const csrfCapturado = ep.headers["x-csrf-token"] || ep.headers["csrf-token"] || ep.headers["x-xsrf-token"] || null;
    const csrf = csrfCapturado || csrfDaPagina;
    const minimo = {
      "Cookie": cookie,
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*",
      "Origin": BASE,
      "Referer": ep.referer,
      ...(ep.postData ? { "Content-Type": ep.headers["content-type"] || "application/json" } : {}),
    };
    const todos = {};
    for (const [k, v] of Object.entries(ep.headers)) {
      if (!NAO_REPASSA.has(k.toLowerCase()) && !k.startsWith(":")) todos[k] = v;
    }

    // Da mais enxuta pra mais completa: a primeira que funcionar é o que a
    // produção vai precisar montar.
    const variantes = [
      ["fetch-direto", minimo],
      ...(csrf ? [["precisa-csrf", { ...minimo, "x-csrf-token": csrf }]] : []),
      ["precisa-headers", { ...todos, "Cookie": cookie, "User-Agent": UA }],
      ...(cookiesDoNavegador ? [["precisa-cookie-do-navegador", { ...todos, "Cookie": cookiesDoNavegador, "User-Agent": UA }]] : []),
    ];

    const tentativas = [];
    let veredito = "so-navegador";
    for (const [nome, headers] of variantes) {
      try {
        const res = await fetch(ep.url, {
          method: ep.method,
          headers,
          body: ep.method === "GET" ? undefined : ep.postData || undefined,
          redirect: "manual",
          signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS),
        });
        const texto = await res.text().catch(() => "");
        let json = false;
        try { JSON.parse(texto); json = true; } catch { /* não é JSON */ }
        tentativas.push({ variante: nome, status: res.status, json, chars: texto.length });
        if (res.ok && json) { veredito = nome; break; }
      } catch (err) {
        tentativas.push({ variante: nome, erro: err.message });
      }
      await sleep(REPLAY_PAUSE_MS);
    }
    const cap = capturas.find(c => c.n === ep.n);
    vereditos.push({ n: ep.n, method: ep.method, url: ep.url, pareceDesempenho: !!cap?.pareceDesempenho, veredito, tentativas });
    console.log(`[sonda] ${veredito.padEnd(28)} ${ep.method} ${ep.url.slice(0, 140)}`);
    await sleep(REPLAY_PAUSE_MS);
  }

  salva("veredito.json", vereditos);
  const contagem = vereditos.reduce((acc, v) => ({ ...acc, [v.veredito]: (acc[v.veredito] || 0) + 1 }), {});
  return finaliza(out, salva, {
    etapa: "replay",
    paginas: paginas.length,
    capturas: capturas.length,
    comCaraDeDesempenho: capturas.filter(c => c.pareceDesempenho).length,
    vereditos: contagem,
  });
}

// O resumo do que a sonda apurou. Como nas outras sondas, o cookie NUNCA entra em
// arquivo nenhum.
function finaliza(out, salva, meta) {
  salva("meta.json", { quando: new Date().toISOString(), ...meta });
  console.log(`[sonda] resumo em ${path.join(out, "meta.json")}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[sonda] falhou:", err.message);
  process.exit(1);
});
