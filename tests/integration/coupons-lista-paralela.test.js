// A etapa 1 abrindo VÁRIAS páginas da lista ao mesmo tempo (task 21).
//
// O que mudou de natureza: o servidor deixou de ter um cursor ("a próxima
// página") e passou a ter uma fila de trabalho. As URLs da lista do ML são
// endereçáveis por offset (`filterUrl`) e o próprio ML declara quantas páginas
// existem, então nada do lado dele obrigava a ir uma por vez — era o cursor.
//
// O que este arquivo protege é o que a fila tornou possível errar:
//
//   - páginas voltam FORA DE ORDEM (a 5 antes da 2), e nenhuma conta pode
//     depender da ordem;
//   - "não tenho página agora" e "a rodada acabou" deixaram de ser a mesma
//     resposta, e confundi-las devolve o paralelismo para o serial;
//   - as paradas antecipadas fecham a ENTREGA, não a rodada: o que já está em voo
//     termina e os cupons daquelas páginas entram;
//   - a passada que CLICA em "Eu quero" continua serial, porque ativar é escrita
//     irreversível na conta do ML.
//
// A fixture é a mesma página real de `/cupons/filter` do `coupons-rodada-local`:
// 8 cupons, 13 páginas declaradas.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const sync = require(path.join(backendDir, "coupons", "sync.js"));
const coupons = require(path.join(backendDir, "coupons"));
// O `sync.js` importa `coupons/pg` DIRETO; o `coupons/index.js` é um spread dele.
// Quem quiser espiar o banco tem que espiar aqui.
const couponsPg = require(path.join(backendDir, "coupons", "pg.js"));

const PROPS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "ml-cupons-filter.json"), "utf8"));

beforeEach(async () => { if (sync.localAtivo()) await sync.fimLocalRun({ cancelada: true }); });
afterEach(async () => { if (sync.localAtivo()) await sync.fimLocalRun({ cancelada: true }); });

// Os cupons da fixture venceram em 01/09/2026 e o carimbo descarta cupom vencido
// — sem congelar o relógio, metade destes testes vira bomba-relógio.
const DIA_DA_FIXTURE = new Date("2026-08-27T12:00:00Z").getTime();
function comORelogioDaFixture() {
  let real;
  beforeEach(() => { real = Date.now; Date.now = () => DIA_DA_FIXTURE; });
  afterEach(() => { Date.now = real; });
}

// Uma página com UM cupom, clonada da fixture: o `parseFilterProps` recusa card
// incompleto, e um objeto montado à mão passaria por motivo errado.
function paginaComCupom(campaignId, { total = 13 } = {}) {
  const cru = JSON.parse(JSON.stringify(PROPS.filteredCouponsData.coupons[0]));
  cru.campaignId = campaignId;
  return { filteredCouponsData: { coupons: [cru], pagination: { total } } };
}

const BASE = { carimbarCategorias: false, limiteCupons: 0, maxPaginasLista: 40 };

describe("a fila de páginas da etapa 1", () => {
  comORelogioDaFixture();

  it("com uma aba só, entrega uma página por vez — como sempre foi", async () => {
    // O guarda-costas de quem NÃO ligou o paralelismo. O padrão é 1, e com 1 o
    // desenho novo tem de ser indistinguível do antigo.
    const r = sync.startLocalRun({ ...BASE, paginasDeListaEmParalelo: 1 });
    expect(r.paralelo).toBe(1);
    expect(r.proximas).toHaveLength(1);
    expect(r.proxima).toEqual(r.proximas[0]);

    const p = await sync.paginaLocal({ grouping: null, pagina: 1, props: PROPS });
    expect(p.proximas).toHaveLength(1);
    expect(p.proximas[0].pagina).toBe(2);
    expect(p.fim).toBe(false);
  });

  it("a página 1 vai sozinha, mesmo com oito abas pedindo", async () => {
    // É ela que revela quantas páginas a entrada tem — e, na lista geral, é ela
    // que faz a fila de verticais crescer. Entregar a 2 antes de a 1 voltar é
    // entregar sem saber até onde ir.
    const r = sync.startLocalRun({ ...BASE, paginasDeListaEmParalelo: 8 });
    expect(r.paralelo).toBe(8);
    expect(r.proximas).toHaveLength(1);

    // E as outras abas, pedindo enquanto a semente não volta, ouvem "espere" —
    // que NÃO é "acabou".
    const espera = sync.pedirProximas(8);
    expect(espera.proximas).toEqual([]);
    expect(espera.fim).toBe(false);
    expect(espera.emVoo).toBe(1);

    // Voltou a semente: agora sim sai o lote.
    const p = await sync.paginaLocal({ grouping: null, pagina: 1, props: PROPS });
    expect(p.proximas.map(x => x.pagina)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("nunca há mais páginas abertas do que abas escolhidas", async () => {
    // O despachante entregava `paralelo` páginas a cada página que voltava, e não
    // `paralelo` no total: quatro abas viravam oito, depois doze. A tela abriria
    // muito mais páginas ao mesmo tempo do que o número que quem opera escolheu —
    // e esse número é o freio inteiro deste recurso.
    sync.startLocalRun({ ...BASE, paginasDeListaEmParalelo: 4 });
    const p1 = await sync.paginaLocal({ grouping: null, pagina: 1, props: PROPS });
    expect(p1.emVoo).toBe(4);

    for (const pagina of [5, 3, 2, 4]) {
      const p = await sync.paginaLocal({ grouping: null, pagina, props: PROPS });
      expect(p.emVoo).toBeLessThanOrEqual(4);
      expect(p.proximas).toHaveLength(1);   // uma vaga, uma página
    }
    expect(sync.pedirProximas(4).proximas).toEqual([]);   // pool cheio
  });

  it("a rodada inteira fora de ordem: nenhuma página pula, nenhuma repete", async () => {
    // O teste que só existe porque a fila existe. Quatro abas devolvendo sempre a
    // mais recente primeiro (uma pilha, o pior caso para quem contava páginas
    // consecutivas), até a lista de 13 páginas acabar.
    sync.startLocalRun({ ...BASE, paginasDeListaEmParalelo: 4 });
    const pendentes = [{ grouping: null, pagina: 1 }];
    const abertas = [];
    let voltas = 0;

    while (pendentes.length && voltas < 50) {
      const alvo = pendentes.pop();          // a última a sair, primeira a voltar
      abertas.push(alvo.pagina);
      voltas++;
      const r = await sync.paginaLocal({ grouping: alvo.grouping, pagina: alvo.pagina, props: PROPS });
      pendentes.push(...(r.proximas || []));
      if (r.fim) break;
    }

    // As 13 que o ML declarou, cada uma exatamente uma vez.
    expect([...abertas].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(pendentes).toEqual([]);
  });

  it("o teto de páginas vale na ENTREGA, e o que já saiu volta e conta", async () => {
    sync.startLocalRun({ ...BASE, paginasDeListaEmParalelo: 4, maxPaginasLista: 3 });
    const p1 = await sync.paginaLocal({ grouping: null, pagina: 1, props: PROPS });
    expect(p1.proximas.map(x => x.pagina)).toEqual([2, 3]);   // não passa do teto
    expect(p1.fim).toBe(false);

    // A 2 volta: a entrada já está fechada pelo teto, mas a 3 ainda está em voo —
    // "fechada" é sobre a entrega, não sobre o resultado.
    const p2 = await sync.paginaLocal({ grouping: null, pagina: 2, props: PROPS });
    expect(p2.fim).toBe(false);

    // A 3 volta com um cupom que só ela tinha. Ele ENTRA: a página já foi aberta
    // na conta do ML, e descartá-la seria jogar fora navegação já paga.
    const p3 = await sync.paginaLocal({ grouping: null, pagina: 3, props: paginaComCupom("99991001") });
    expect(p3.fim).toBe(true);
    expect(p3.resumo.avisos.join(" ")).toMatch(/teto de 3 páginas/i);
    expect(await coupons.getCoupon("99991001")).toBeTruthy();
  });

  it("quatro páginas secas em voo não matam a entrada antes da hora", async () => {
    // O corte de "cinco páginas sem novidade" contava páginas CONSECUTIVAS. Com
    // quatro abas, um trecho seco enchia o contador numa ida-e-volta só e cortava
    // a lista muito antes das cinco páginas que a regra promete. Agora o critério
    // é profundidade: a distância entre o que falta e a última página que rendeu.
    sync.startLocalRun({ ...BASE, paginasDeListaEmParalelo: 4 });
    await sync.paginaLocal({ grouping: null, pagina: 1, props: PROPS });
    for (const pagina of [2, 3, 4]) {
      await sync.paginaLocal({ grouping: null, pagina, props: PROPS });   // nada novo
    }
    // A quinta traz cupom novo: a entrada tem de estar viva para recebê-la.
    const p5 = await sync.paginaLocal({ grouping: null, pagina: 5, props: paginaComCupom("99991002") });
    expect(p5.fim).toBe(false);
    expect(p5.novos).toBe(1);
    expect(p5.proximas).toHaveLength(1);
  });

  it("a lista seca acaba na mesma profundidade de sempre", async () => {
    // O outro lado do teste acima: afrouxar o corte não pode ter desligado ele.
    sync.startLocalRun({ ...BASE, paginasDeListaEmParalelo: 1 });
    await sync.paginaLocal({ grouping: null, pagina: 1, props: PROPS });
    let ultima;
    for (let pagina = 2; pagina <= 7; pagina++) {
      ultima = await sync.paginaLocal({ grouping: null, pagina, props: PROPS });
      if (ultima.fim) break;
    }
    expect(ultima.fim).toBe(true);
    expect(ultima.paginasLidas).toBe(6);   // a 1 rendeu; 2..6 secas é o corte
  });
});

describe("a fila e a escrita na conta do ML", () => {
  comORelogioDaFixture();

  it("a passada que clica em 'Eu quero' continua serial, mande-se o que mandar", async () => {
    // Ativar é a única escrita que o sistema faz na conta do ML, e a etapa 2
    // depende de ela ser serial. O freio é do SERVIDOR: a tela não decide isto.
    const r = sync.startLocalRun({ ativarApenas: ["13907402"], paginasDeListaEmParalelo: 8, activateCoupons: true });
    expect(r.paralelo).toBe(1);
    expect(r.proximas).toHaveLength(1);
    expect(sync.pedirProximas(8).proximas.length).toBeLessThanOrEqual(1);
  });

  it("a mesma página postada duas vezes não debita o orçamento duas vezes", async () => {
    // Uma aba que refaz o POST depois de um timeout. Juntar os cupons de novo é
    // inofensivo (o merge é idempotente); debitar de novo gastaria ativações que
    // nunca aconteceram — e cada ativação é um clique irreversível na conta.
    sync.startLocalRun({ ativarApenas: ["99990000"], activateCoupons: true, maxActivationsPerRun: 5 });
    await sync.paginaLocal({ grouping: null, pagina: 1, props: PROPS, ativados: 2 });
    expect(sync.ativacoesLocais({ props: PROPS }).restantes).toBe(3);

    await sync.paginaLocal({ grouping: null, pagina: 1, props: PROPS, ativados: 2 });
    expect(sync.ativacoesLocais({ props: PROPS }).restantes).toBe(3);
  });
});

describe("a barreira do carimbo", () => {
  comORelogioDaFixture();

  it("as verticais só abrem com a lista geral QUIETA, e o carimbo decide uma vez só", async () => {
    // `abrirCarimbo` monta a lista de quem ainda precisa de categoria olhando o
    // `porId` INTEIRO. Abrir uma vertical com páginas da geral ainda voltando é
    // decidir com a coleta pela metade — e chamar duas vezes reescreveria o total
    // da barra e levaria a consulta em dobro ao banco.
    const real = couponsPg.campanhasComCategoria;
    let chamadas = 0;
    couponsPg.campanhasComCategoria = async (...a) => { chamadas++; return real.apply(couponsPg, a); };
    try {
      sync.startLocalRun({ carimbarCategorias: true, categorias: ["ce_vertical"], limiteCupons: 0, maxPaginasLista: 3, paginasDeListaEmParalelo: 4 });
      const p1 = await sync.paginaLocal({ grouping: null, pagina: 1, props: PROPS });
      expect(p1.proximas.map(x => x.pagina)).toEqual([2, 3]);
      // Nenhuma vertical enquanto a geral tem página em voo.
      expect(p1.proximas.every(x => x.grouping === null)).toBe(true);

      const p2 = await sync.paginaLocal({ grouping: null, pagina: 2, props: PROPS });
      expect(p2.proximas.every(x => x.grouping === null)).toBe(true);
      expect(chamadas).toBe(0);

      // A última da geral volta: agora a fila pode ir para a vertical.
      const p3 = await sync.paginaLocal({ grouping: null, pagina: 3, props: PROPS });
      expect(p3.proximas[0].grouping).toBe("ce_vertical");
      expect(chamadas).toBe(1);
    } finally { couponsPg.campanhasComCategoria = real; }
  });
});

describe("a aba que morre no meio", () => {
  comORelogioDaFixture();

  it("a página que não volta é pedida de novo, em vez de pendurar a rodada", async () => {
    // Sem isto, uma aba fechada na mão deixa a entrada eternamente "com algo em
    // voo": a rodada nunca fica quieta e só termina no watchdog de 5 minutos.
    sync.startLocalRun({ ...BASE, paginasDeListaEmParalelo: 2 });
    const p1 = await sync.paginaLocal({ grouping: null, pagina: 1, props: PROPS });
    expect(p1.proximas.map(x => x.pagina)).toEqual([2, 3]);

    // A 2 volta; a 3 nunca volta.
    await sync.paginaLocal({ grouping: null, pagina: 2, props: PROPS });
    const agora = Date.now;
    Date.now = () => DIA_DA_FIXTURE + 10 * 60 * 1000;
    try {
      const r = sync.pedirProximas(2);
      expect(r.proximas.map(x => x.pagina)).toContain(3);
    } finally { Date.now = agora; }
  });
});
