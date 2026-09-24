// A porta da extensão: recebe um comando da tela do admin, executa no Chrome do
// próprio admin e devolve o resultado.
//
// Por que a extensão existe: o Mercado Livre responde CAPTCHA para navegador
// automatizado — a sonda de 27/08 mostrou que isso acontece MESMO fora da VPS, e
// não é o IP: é o Puppeteer subindo Chrome. Numa aba do Chrome do admin, com a
// sessão dele, a mesma página é só uma página. E a página do admin, sozinha, não
// consegue ler o conteúdo de uma aba do ML (mesma-origem) — a extensão é a única
// peça com essa permissão.
//
// A regra que segura este arquivo: ela COLHE material cru e entrega. Quem
// interpreta e grava é o servidor, nas funções puras que já existem lá
// (`parseFilterProps`, `classifyCodeCheck`, `aAtivar`, `validarProdutosDaVitrine`).
// Nenhuma delas é copiada para cá — regra duplicada é regra que diverge.

import { raspar } from "./vitrine.js";
import { props } from "./props.js";
import { lista, fecharAba } from "./lista.js";
import { palavra } from "./palavra.js";
import { checkout, cuponsNoCheckout } from "./checkout.js";
import { cupomNoCheckout } from "./cupom-checkout.js";

// Cada comando recebe (payload, progresso) e devolve um objeto serializável.
// A tela consulta esta lista pelo anúncio da ponte: é assim que ela sabe se a
// extensão instalada é velha demais para o que vai pedir.
const COMANDOS = {
  raspar,
  props,
  lista,
  palavra,
  checkout,
  "cupons-checkout": cuponsNoCheckout,
  // O mesmo comando; o nome novo só existe para a tela saber que esta cópia entende
  // `rapido`, `semCarrinho` e `tempos` (o lote da sonda) — a velha os ignoraria calada.
  "cupons-checkout-v2": cuponsNoCheckout,
  // O cupom do repasse testado no checkout do produto, dentro do iframe do modal
  // "Cupons" (task 7).
  "cupom-no-checkout": cupomNoCheckout,
  "fechar-aba": fecharAba,
};

chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  // Quais comandos esta versão entende. Pergunta barata da ponte, sem aba.
  if (msg?.tipo === "quais-comandos") {
    responder({ ok: true, comandos: Object.keys(COMANDOS) });
    return false;
  }

  const comando = COMANDOS[msg?.tipo];
  if (!comando) return false;

  // A ponte só é injetada nos endereços do manifest, mas conferir a origem do
  // remetente é barato e fecha a porta se esse arquivo mudar um dia.
  if (!sender.tab) { responder({ ok: false, erro: "pedido sem aba de origem" }); return false; }

  // O evento vai DENTRO de `evento`, não espalhado: o progresso carrega o próprio
  // `tipo` ("pagina", "muro"), e espalhar aqui sobrescrevia o "progresso" que a
  // ponte procura — o progresso ao vivo simplesmente não chegava na tela.
  const progresso = (evento) => chrome.tabs.sendMessage(sender.tab.id, { de: "nimbus-coletor", tipo: "progresso", id: msg.id, evento }).catch(() => {});

  comando(msg, progresso)
    .then(r => responder({ ok: true, ...r }))
    .catch(err => responder({ ok: false, erro: err.message }));

  return true;   // resposta assíncrona
});
