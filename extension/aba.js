// A aba de trabalho: abrir, esperar, injetar, esperar o humano, fechar.
//
// Estava tudo dentro do laço da vitrine enquanto a extensão tinha um comando só.
// Agora que ela tem vários (vitrine, lista de cupons, palavra), esta é a parte que
// todos repetem — e o único lugar onde a política do muro está escrita.
//
// A aba abre em SEGUNDO PLANO (`active: false`): quem pediu está na tela do admin
// e é lá que o progresso aparece. Ela só vem para a frente numa situação — o ML
// pedindo verificação —, porque aí a decisão é do humano.

export const ESPERA_CARGA_MS = 45000;
export const ESPERA_MURO_MS = 5 * 60 * 1000;   // quanto se espera o humano resolver

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Espera a aba terminar de carregar. `webNavigation` daria o mesmo com mais
// permissão pedida; `tabs.onUpdated` basta e não amplia o que a extensão pode ver.
export function esperarCarregar(tabId, timeout = ESPERA_CARGA_MS) {
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

// `ativa` = na frente, com a janela focada: só o modo depuração pede isso.
export async function abrir(url, { ativa = false } = {}) {
  const aba = await chrome.tabs.create({ url, active: !!ativa });
  if (ativa) await chrome.windows.update(aba.windowId, { focused: true }).catch(() => {});
  await esperarCarregar(aba.id);
  return aba.id;
}

export async function irPara(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await esperarCarregar(tabId);
}

export async function fechar(tabId) {
  await chrome.tabs.remove(tabId).catch(() => { /* já pode ter sido fechada */ });
}

// Injeta um ARQUIVO no mundo isolado da extensão (é assim que o `colher.js` roda).
export async function injetarArquivo(tabId, arquivo) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, files: [arquivo] });
  return r?.result;
}

// Roda uma função DENTRO da página. `world: "MAIN"` é o que dá acesso aos globais
// do ML (`window._n.ctx.r`) — no mundo isolado eles não existem. A função é
// serializada, então ela não pode fechar sobre nada deste arquivo.
export async function avaliar(tabId, func, args = [], { mundoDaPagina = false } = {}) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
    ...(mundoDaPagina ? { world: "MAIN" } : {}),
  });
  return r?.result;
}

// O muro do ML, classificado a partir do que a página mostra. Gêmeo de
// `backend/scraping/ml-session-page.js:classifyMLWall` e da função `muro` do
// `colher.js` (aquele não importa daqui: é injetado solto, sem build no meio).
//
// Só deve ser consultado quando a leitura não trouxe NADA — um cupom chamado
// "captcha" não pode virar bloqueio falso.
export function classificarMuro(url = "", texto = "", titulo = "") {
  const hay = `${url}\n${texto}\n${titulo}`;
  if (/\/captcha\/wall/i.test(url) || /n[ãa]o sou um rob[ôo]|por seguran[çc]a, complete/i.test(hay)) return "captcha";
  if (/\/gz\/account-verification/i.test(url)) return "verificacao";
  if (/\/gz\/login/i.test(url) || /acesse sua conta/i.test(hay)) return "login";
  return null;
}

// O muro. A extensão NÃO tenta contornar: traz a aba para a frente, avisa quem
// pediu e espera a página deixar de ser o desafio. Se o tempo acabar, desiste — e
// o que já foi colhido volta marcado como parcial.
//
// `reler` é a leitura daquele comando (vitrine, props, …) e precisa devolver algo
// com `.muro`: é ela que diz se o humano já resolveu.
export async function esperarHumano(tabId, reler, aviso) {
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update((await chrome.tabs.get(tabId)).windowId, { focused: true }).catch(() => {});
  aviso();

  const ate = Date.now() + ESPERA_MURO_MS;
  while (Date.now() < ate) {
    await sleep(2000);
    let aba;
    try { aba = await chrome.tabs.get(tabId); } catch { return false; }   // fechou na mão
    if (aba.status !== "complete") continue;
    const r = await reler().catch(() => null);
    if (r && !r.muro) return true;
  }
  return false;
}
