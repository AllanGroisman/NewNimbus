// O laço da coleta: abre a vitrine numa aba, injeta o colhedor, pagina e devolve.
//
// A aba abre em SEGUNDO PLANO (`active: false`): quem pediu está na tela do
// admin e é lá que o progresso aparece. Ela só vem para a frente numa situação —
// o ML pedindo verificação —, porque aí a decisão é do humano.

const PAGINAS_MAX = 6;              // 48 por página → até ~288 produtos
const TAMANHO_PAGINA = 48;          // o `_Desde_` do ML anda de 48 em 48 (1, 49, 97…)
const ESPERA_CARGA_MS = 45000;
const PAUSA_PAGINA_MS = 1200;
const ESPERA_MURO_MS = 5 * 60 * 1000;   // quanto se espera o humano resolver

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Gêmeo de `backend/scraping/ml-cupons.js:containerPageUrl`. O ML não pagina com
// `?page=`: ele põe `_Desde_<offset+1>` no CAMINHO, antes da query.
function urlDaPagina(url, n) {
  if (n <= 1) return url;
  const u = new URL(url);
  u.pathname = `${u.pathname.replace(/_Desde_\d+/i, "")}_Desde_${(n - 1) * TAMANHO_PAGINA + 1}`;
  return u.href;
}

// Espera a aba terminar de carregar. `webNavigation` daria o mesmo com mais
// permissão pedida; `tabs.onUpdated` basta e não amplia o que a extensão pode ver.
function esperarCarregar(tabId, timeout = ESPERA_CARGA_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(ouvir); reject(new Error("a página demorou demais para carregar")); }, timeout);
    function ouvir(id, info) {
      if (id !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(ouvir);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(ouvir);
  });
}

async function colherAba(tabId) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, files: ["colher.js"] });
  return r?.result || { produtos: [], muro: null };
}

// O muro. A extensão NÃO tenta contornar: traz a aba para a frente, avisa quem
// pediu e espera a página deixar de ser o desafio. Se o tempo acabar, desiste — e
// o que já foi colhido volta marcado como parcial.
async function esperarHumano(tabId, aviso) {
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update((await chrome.tabs.get(tabId)).windowId, { focused: true }).catch(() => {});
  aviso();

  const ate = Date.now() + ESPERA_MURO_MS;
  while (Date.now() < ate) {
    await sleep(2000);
    let aba;
    try { aba = await chrome.tabs.get(tabId); } catch { return false; }   // fechou na mão
    if (aba.status !== "complete") continue;
    const r = await colherAba(tabId).catch(() => null);
    if (r && !r.muro) return true;
  }
  return false;
}

// Devolve { produtos, parcial, motivo, paginas }.
async function raspar(containerUrl, { paginas = PAGINAS_MAX }, progresso) {
  const aba = await chrome.tabs.create({ url: urlDaPagina(containerUrl, 1), active: false });
  const tabId = aba.id;
  const vistos = new Set();
  const produtos = [];
  let parcial = false;
  let motivo = null;
  let n = 0;

  try {
    for (n = 1; n <= paginas; n++) {
      if (n > 1) {
        await chrome.tabs.update(tabId, { url: urlDaPagina(containerUrl, n) });
      }
      await esperarCarregar(tabId);
      let r = await colherAba(tabId);

      if (r.muro) {
        const resolvido = await esperarHumano(tabId, () => progresso({ tipo: "muro", muro: r.muro, pagina: n }));
        if (!resolvido) { parcial = true; motivo = "o Mercado Livre pediu verificação e ela não foi resolvida"; break; }
        r = await colherAba(tabId);
      }

      // Página sem card é o fim da lista — o ML não diz quantas páginas tem.
      if (!r.produtos.length) break;

      let novos = 0;
      for (const p of r.produtos) {
        if (!p.link || vistos.has(p.link)) continue;
        vistos.add(p.link);
        produtos.push(p);
        novos++;
      }
      progresso({ tipo: "pagina", pagina: n, produtos: produtos.length });

      // O ML começou a repetir: passou da última página.
      if (!novos) break;

      // Bateu o teto com a lista ainda rendendo: sobrou vitrine lá, e isso é
      // parcial. Gravar como lista fechada faria o sistema dizer "não vale aqui"
      // para produto que o cupom cobre.
      if (n === paginas) { parcial = true; motivo = `parei no teto de ${paginas} páginas`; }

      await sleep(PAUSA_PAGINA_MS);
    }
  } finally {
    await chrome.tabs.remove(tabId).catch(() => { /* já pode ter sido fechada */ });
  }

  return { produtos, parcial, motivo, paginas: Math.min(n, paginas) };
}

// A porta: só a `ponte.js` (content script no endereço do sistema) fala aqui.
chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  if (msg?.tipo !== "raspar") return false;
  // A ponte só é injetada nos endereços do manifest, mas conferir a origem do
  // remetente é barato e fecha a porta se esse arquivo mudar um dia.
  if (!sender.tab) { responder({ ok: false, erro: "pedido sem aba de origem" }); return false; }

  const progresso = (p) => chrome.tabs.sendMessage(sender.tab.id, { de: "nimbus-coletor", tipo: "progresso", ...p }).catch(() => {});

  raspar(msg.containerUrl, { paginas: msg.paginas }, progresso)
    .then(r => responder({ ok: true, ...r }))
    .catch(err => responder({ ok: false, erro: err.message }));

  return true;   // resposta assíncrona
});
