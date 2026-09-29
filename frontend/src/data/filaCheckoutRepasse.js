// A fila do teste de cupom no checkout (aba Repasse) FORA da tela (task 29).
//
// O teste roda no Chrome do admin, pela extensão, e o "Testar todos" leva minutos.
// O card (FilaCheckoutRepasse.jsx) é montado do zero toda vez que se troca de aba
// ou de página: com o estado dentro dele, sair e voltar deixava o laço correndo às
// cegas — sem "testando…", sem barra, sem "Parar" (a ref antiga ficava órfã) e com
// os botões ativos para disparar um segundo teste por cima. Aqui o estado vive no
// módulo, como a rodada dos cupons do ML (rodadaCupons.js): dura enquanto a página
// estiver aberta, e um F5 continua matando o laço, porque ele é JS desta página.
//
// A tela lê com `useFilaCheckout()`. O store não chama a tela: o "releia a fila"
// vira o contador `recargas`, e a tela reage a ele com um efeito.
import { useSyncExternalStore } from "react";
import { adminRepasseCupomCheckoutReivindicar, errText } from "./api";
import { testarNoCheckout } from "./cupomCheckoutRepasse";

// Os passos de um teste, na ordem em que a extensão os anuncia
// (extension/cupom-checkout.js e checkout.js). A fração é o quanto da barra do
// cupom atual aquele passo representa — o teste não sabe quanto falta, mas sabe
// em que ponto do caminho está.
const PASSOS = {
  inicio: { rotulo: "abrindo o produto", fracao: 0.1 },
  variacao: { rotulo: "escolhendo a variação", fracao: 0.25 },
  checkout: { rotulo: "indo ao checkout", fracao: 0.4 },
  passo: { rotulo: "indo ao checkout", fracao: 0.45 },
  seguro: { rotulo: "indo ao checkout", fracao: 0.45 },
  "cupons-modal": { rotulo: "abrindo os cupons", fracao: 0.6 },
  aplicado: { rotulo: "aplicando o código", fracao: 0.8 },
  capturado: { rotulo: "lendo a resposta", fracao: 0.9 },
  muro: { rotulo: "o ML pediu verificação — resolva na aba que abriu" },
};

// O evento da extensão → { rotulo, fracao }. Evento desconhecido não mexe no passo;
// o muro e o passo do modo depuração trocam o rótulo mas não andam a barra.
export function passoDoEvento(anterior, ev) {
  if (ev?.tipo === "passo-depuracao") return { ...anterior, rotulo: ev.rotulo };
  const p = PASSOS[ev?.tipo];
  if (!p) return anterior;
  return { rotulo: p.rotulo, fracao: p.fracao ?? anterior?.fracao ?? 0 };
}

const INICIAL = {
  // O código no checkout agora, quando começou e em que passo está.
  testando: null,
  inicioEm: null,
  passo: null,
  // O "Testar todos": { total, feitos } enquanto anda; null fora dele.
  lote: null,
  // O último desfecho de cada código testado pela fila — o item some da fila
  // depois do teste, e sem isto o resultado sumiria junto.
  resultados: [],
  aviso: null,
  // Pedido à tela: releia a fila.
  recargas: 0,
};

let estado = INICIAL;
const ouvintes = new Set();
// O "Parar". Lido pelo laço entre um cupom e outro — por isso não é estado de React.
let parado = false;
// Um "Testar todos" por vez.
let emCurso = false;
// Quem quer saber do desfecho (a lista da página, para atualizar a linha no lugar).
// Só existe enquanto a página está montada.
let aoTestar = null;

// Um teste no Chrome de cada vez, venha da fila, do botão da linha ou do produto:
// o checkout é um só por conta do ML, e dois ao mesmo tempo se atropelariam. Mora
// no módulo para valer também entre montagens da página.
let serie = Promise.resolve();
let ocupados = 0;

export function emSerie(fn) {
  ocupados += 1;
  const p = serie.then(fn, fn).finally(() => { ocupados -= 1; });
  serie = p.catch(() => {});
  return p;
}

export const ocupado = () => ocupados > 0;

function set(patch) {
  estado = { ...estado, ...(typeof patch === "function" ? patch(estado) : patch) };
  ouvintes.forEach(f => f());
}

const recarregar = () => set(e => ({ recargas: e.recargas + 1 }));

function subscribe(f) {
  ouvintes.add(f);
  return () => ouvintes.delete(f);
}

export function useFilaCheckout() {
  return useSyncExternalStore(subscribe, () => estado);
}

export function registrarAoTestar(fn) {
  aoTestar = fn;
  return () => { if (aoTestar === fn) aoTestar = null; };
}

export const avisar = (aviso) => set({ aviso });

export function parar() {
  parado = true;
}

// Só para os testes: o módulo dura a suíte inteira, e um teste herdaria a fila
// do outro.
export function _zerarParaTestes() {
  estado = INICIAL;
  parado = false;
  emCurso = false;
  aoTestar = null;
  serie = Promise.resolve();
  ocupados = 0;
  ouvintes.forEach(f => f());
}

// Um item: reivindica (outra aba pode estar nele), roda na extensão, grava.
// Devolve null quando outra aba já estava nele.
export async function testarItem(item, source, { depurar = false } = {}) {
  try {
    await adminRepasseCupomCheckoutReivindicar(item.code);
  } catch (err) {
    if (err?.status === 409) { set({ aviso: `${item.code}: outra aba já está testando esse cupom.` }); return null; }
    throw err;
  }
  set({ testando: item.code, inicioEm: Date.now(), passo: passoDoEvento(null, { tipo: "inicio" }) });
  const onProgresso = (ev) => set(e => ({ passo: passoDoEvento(e.passo, ev) }));
  try {
    const res = await emSerie(() => testarNoCheckout(item.code, item.url, {
      source, manualId: item.manualId || null, depurar, onProgresso,
    }));
    aoTestar?.(item.code, res);
    // A mensagem já diz "ligado ao produto"; a campanha nova só o vínculo sabe.
    const texto = `${res.message || res.verdict}${res.vinculo?.cuponsNovos ? " · campanha nova no sistema" : ""}`;
    set(e => ({
      resultados: [{ code: item.code, url: item.url, verdict: res.verdict, texto, em: new Date().toISOString() },
        ...e.resultados.filter(r => r.code !== item.code)].slice(0, 20),
      aviso: null,
    }));
    return res;
  } finally {
    set({ testando: null, inicioEm: null, passo: null });
  }
}

// A fila inteira, na ordem, um de cada vez. Parar vale ENTRE itens: o que está
// no meio do checkout termina (fechar a aba no meio deixaria o carrinho sujo).
export async function testarTodos(itens, { depurar = false } = {}) {
  if (emCurso) return;
  emCurso = true;
  parado = false;
  const alvo = (itens || []).filter(i => !i.reservado);
  set({ lote: { total: alvo.length, feitos: 0 } });
  try {
    for (const item of alvo) {
      if (parado) break;
      try {
        await testarItem(item, "repasse-checkout", { depurar });
      } catch (err) {
        set({ aviso: errText(err, `Não deu pra testar ${item.code}.`) });
      }
      set(e => ({ lote: e.lote && { ...e.lote, feitos: e.lote.feitos + 1 } }));
      recarregar();
    }
  } finally {
    emCurso = false;
    set({ lote: null });
  }
}

// O Testar de um item só (e a volta do automático): o mesmo caminho, e a fila
// relida no fim.
export async function testarUm(item, source = "repasse-checkout", opcoes) {
  try {
    return await testarItem(item, source, opcoes);
  } finally {
    recarregar();
  }
}
