// A rodada de cupons tocada pelo Chrome do admin (a extensão).
//
// Contexto: o Mercado Livre responde CAPTCHA para navegador automatizado — a sonda
// de 27/08/2026 mostrou que isso acontece mesmo fora da VPS, porque o problema é o
// Puppeteer, não o IP. Numa aba do Chrome do admin a mesma lista é só uma página.
//
// O que muda de mãos, então, é só QUEM abre a página. O que este arquivo protege é
// que nada mais mudou de lugar:
//
//   - o parse continua sendo o `parseFilterProps` (o mesmo da rodada do servidor);
//   - quem escolhe cupom para ATIVAR continua sendo o `aAtivar`, aqui — ativar é
//     escrita irreversível na conta do ML, e a extensão não pode palpitar;
//   - onde a varredura para continua sendo decidido aqui, não no laço da tela;
//   - a gravação continua sendo o `persistRun`.
//
// A fixture é uma página real de `/cupons/filter` (27/08/2026): 8 cupons, 3 de
// loja, 13 páginas no total.
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

const PROPS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "ml-cupons-filter.json"), "utf8"));

// A rodada é estado de módulo: uma que fica pendurada quebra a próxima.
beforeEach(() => { if (sync.localAtivo()) sync.fimLocalRun({ cancelada: true }); });
afterEach(() => { if (sync.localAtivo()) sync.fimLocalRun({ cancelada: true }); });

// Os cupons da fixture venceram em 01/09/2026, e o `aAtivar` recusa cupom vencido
// — com razão: clicar em "Eu quero" num cupom morto é escrita à toa na conta. Só
// que isso transformava todo teste de ATIVAÇÃO daqui numa bomba-relógio, que
// estourou sozinha no dia 01/09 sem ninguém ter mexido no código. Quem congela o
// relógio é o teste, não o código.
const DIA_DA_FIXTURE = new Date("2026-08-27T12:00:00Z").getTime();
function comORelogioDaFixture() {
  let real;
  beforeEach(() => { real = Date.now; Date.now = () => DIA_DA_FIXTURE; });
  afterEach(() => { Date.now = real; });
}

describe("startLocalRun", () => {
  it("diz qual é a primeira página a abrir — a extensão não monta URL nenhuma", () => {
    const r = sync.startLocalRun({ groupings: [], limitPerGrouping: 5, activateCoupons: false });
    expect(r.proxima.url).toContain("mercadolivre.com.br/cupons/filter");
    expect(r.proxima.url).toContain("all=true");
    expect(r.proxima.pagina).toBe(1);
    expect(sync.status().running).toBe(true);
    expect(sync.status().local).toBe(true);
  });

  it("recusa a segunda rodada: as duas mexem na mesma conta do ML", () => {
    sync.startLocalRun({ limitPerGrouping: 5 });
    expect(() => sync.startLocalRun({})).toThrow(/rodada de cupons rodando/i);
  });
});

describe("ativacoesLocais", () => {
  comORelogioDaFixture();

  it("devolve só os rótulos que o aAtivar aprovou", () => {
    sync.startLocalRun({ limitPerGrouping: 5, activateCoupons: true, maxActivationsPerRun: 20 });
    const { labels } = sync.ativacoesLocais({ grouping: null, props: PROPS });
    // Os três não ativados da página. Os já ativados e os de loja ficam de fora —
    // clicar neles é escrita à toa na conta.
    expect(labels).toHaveLength(3);
    for (const l of labels) expect(l).toMatch(/^Aplicar cupom /);
  });

  it("o teto de ativações da rodada é respeitado", () => {
    sync.startLocalRun({ limitPerGrouping: 5, activateCoupons: true, maxActivationsPerRun: 1 });
    expect(sync.ativacoesLocais({ props: PROPS }).labels).toHaveLength(1);
  });

  it("com a ativação desligada, ninguém é clicado", () => {
    sync.startLocalRun({ limitPerGrouping: 5, activateCoupons: false });
    expect(sync.ativacoesLocais({ props: PROPS }).labels).toEqual([]);
  });

  it("gasto o teto, não sobra ativação para a página seguinte", async () => {
    sync.startLocalRun({ limitPerGrouping: 200, activateCoupons: true, maxActivationsPerRun: 2 });
    expect(sync.ativacoesLocais({ props: PROPS }).labels).toHaveLength(2);
    await sync.paginaLocal({ props: PROPS, ativados: 2 });
    expect(sync.ativacoesLocais({ props: PROPS }).labels).toEqual([]);
  });
});

describe("paginaLocal", () => {
  it("pede a próxima página enquanto a lista rende e o limite não chegou", async () => {
    sync.startLocalRun({ limitPerGrouping: 200, activateCoupons: false });
    const r = await sync.paginaLocal({ grouping: null, props: PROPS });
    // 8 cupons na fixture, 3 de loja descartados antes de entrar.
    expect(r.cupons).toBe(5);
    expect(r.ignoradosLoja).toBe(3);
    expect(r.de).toBe(13);
    expect(r.proxima.pagina).toBe(2);
    expect(r.alvos).toBeNull();
  });

  it("cupom de loja não conta para o limite da categoria", async () => {
    sync.startLocalRun({ limitPerGrouping: 200, activateCoupons: false, skipStoreCoupons: false });
    const r = await sync.paginaLocal({ props: PROPS });
    expect(r.cupons).toBe(8);
    expect(r.ignoradosLoja).toBe(0);
  });

  it("batido o limite da categoria, a varredura acaba e os cupons são gravados", async () => {
    sync.startLocalRun({ limitPerGrouping: 3, activateCoupons: false });
    const r = await sync.paginaLocal({ grouping: null, props: PROPS });
    expect(r.proxima).toBeNull();
    expect(r.resumo.cupons).toBe(3);
    // Gravou de verdade: é isto que o `gravarVitrineLocal` da colheita seguinte
    // exige, e é o que sobra se o Chrome fechar no meio das vitrines.
    const guardado = await coupons.getCoupon(r.alvos[0]?.campaignId || "");
    expect(guardado).toBeTruthy();
  });

  it("só entram em `alvos` os cupons que têm vitrine para abrir", async () => {
    sync.startLocalRun({ limitPerGrouping: 200, activateCoupons: false });
    // A mesma página, repetida: o ML começou a devolver o que já veio. A rodada
    // desiste depois de MAX_PAGINAS_SEM_NOVIDADE — o mesmo freio do crawlFilter,
    // que existe porque a lista do ML às vezes pagina em círculo.
    let r = null;
    for (let i = 0; i < 10 && (!r || r.proxima); i++) r = await sync.paginaLocal({ props: PROPS });
    expect(r.proxima).toBeNull();
    for (const a of r.alvos) expect(a.containerUrl).toBeTruthy();
    expect(r.alvos.length).toBeLessThanOrEqual(r.resumo.cupons);
  });

  it("página sem cupom nenhum encerra em vez de insistir", async () => {
    sync.startLocalRun({ limitPerGrouping: 200, activateCoupons: false });
    const r = await sync.paginaLocal({ props: { filteredCouponsData: { coupons: [], pagination: { page: 1, total: 5 } } } });
    expect(r.proxima).toBeNull();
    expect(r.resumo.avisos.join(" ")).toMatch(/não devolveu cupom nenhum/i);
  });

  it("sem rodada em andamento não se grava nada", async () => {
    await expect(sync.paginaLocal({ props: PROPS })).rejects.toThrow(/rodada no Chrome/i);
  });
});

describe("fimLocalRun", () => {
  it("libera a rodada e guarda o balanço", async () => {
    sync.startLocalRun({ limitPerGrouping: 3, activateCoupons: false });
    await sync.paginaLocal({ props: PROPS });
    const { resumo } = sync.fimLocalRun({ vitrines: 2, produtos: 40 });
    expect(resumo.cupons).toBe(3);
    expect(resumo.cuponsComVitrine).toBe(2);
    expect(resumo.vinculos).toBe(40);
    expect(resumo.origem).toBe("extensao");
    // Sem isto o /run e o "Apagar todos" recusariam para sempre.
    expect(sync.status().running).toBe(false);
    expect(sync.localAtivo()).toBe(false);
  });

  it("a rodada abandonada no meio expira sozinha em vez de travar a próxima", () => {
    sync.startLocalRun({ limitPerGrouping: 3 });
    // O admin fechou a aba: ninguém mais chama nada. O relógio da rodada é o que
    // devolve o sistema ao normal.
    const antes = Date.now;
    Date.now = () => antes() + 10 * 60 * 1000;
    try {
      expect(sync.status().running).toBe(false);
      expect(() => sync.startLocalRun({})).not.toThrow();
    } finally {
      Date.now = antes;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A mesma máquina, procurando UMA campanha
// ─────────────────────────────────────────────────────────────────────────
//
// É o "trazer campanha" do teste de palavra: o ML disse a que campanha a palavra
// pertence e o sistema não tem esse cupom. Buscar é percorrer a mesma lista — só
// que parando na página em que ela aparecer, porque cada página é uma navegação
// com a conta do sistema.
// Task 26: "ta puxando só de brinquedos e hobbies, quero que puxe de tudo".
//
// "Todas as categorias" passou a querer dizer uma passada POR VERTICAL, e não uma
// passada só na lista geral. O motivo é que o ML não diz a vertical do cupom na
// lista: a categoria que o sistema grava é o filtro que a rodada pediu na URL, então
// a passada geral trazia tudo sem categoria nenhuma.
describe("startLocalRun sem categoria escolhida", () => {
  beforeEach(() => {
    // O dicionário de nomes é o que diz quais categorias existem. Junto das
    // verticais vêm três chaves que NÃO são categoria — são filtros do ML.
    sync.mergeGroupingLabels([
      { key: "ce_vertical", title: "Eletrônicos, Áudio e Vídeo" },
      { key: "fa_vertical", title: "Moda e acessórios" },
      { key: "tb_vertical", title: "Brinquedos, Hobbies e Bebês" },
      { key: "price", title: "Mais de R$100" },
      { key: "percentage", title: "Mais de 10%" },
    ]);
  });

  it("varre uma categoria de cada vez, começando pela primeira", () => {
    const r = sync.startLocalRun({ groupings: [], activateCoupons: false });
    expect(r.categorias).toEqual(["ce_vertical", "fa_vertical", "tb_vertical"]);
    expect(r.proxima.grouping).toBe("ce_vertical");
    expect(r.proxima.url).toContain("ce_vertical=true");
  });

  it("esgotada a categoria, a próxima página é da categoria seguinte", async () => {
    // `limitPerGrouping: 3` esgota já na primeira página (a fixture rende 5 de
    // campanha), então a rodada vira de categoria em vez de encerrar — que é o que
    // acontecia quando "todas" era uma passada só.
    sync.startLocalRun({ groupings: [], limitPerGrouping: 3, activateCoupons: false });
    const r = await sync.paginaLocal({ grouping: "ce_vertical", props: PROPS });
    expect(r.proxima).not.toBeNull();
    expect(r.proxima.grouping).toBe("fa_vertical");
    expect(r.proxima.pagina).toBe(1);
  });

  it("o cupom entra carimbado com a categoria da passada — é isso que a passada geral não dava", async () => {
    sync.startLocalRun({ groupings: [], limitPerGrouping: 3, activateCoupons: false });
    // A mesma fixture nas três categorias: o cupom aparece em todas, e a rodada
    // tem de guardar a UNIÃO delas, não a última.
    let r = null;
    while (!r || r.proxima) r = await sync.paginaLocal({ grouping: r ? r.proxima.grouping : "ce_vertical", props: PROPS });
    const guardado = await coupons.getCoupon("13491809");
    expect(guardado.groupings.sort()).toEqual(["ce_vertical", "fa_vertical", "tb_vertical"]);
  });
});

describe("startLocalRun com uma campanha alvo", () => {
  comORelogioDaFixture();

  const NA_FIXTURE = "14063164";

  it("para assim que a campanha aparece, sem pedir a página seguinte", async () => {
    sync.startLocalRun({ procurar: NA_FIXTURE, activateCoupons: false });
    const r = await sync.paginaLocal({ props: PROPS });
    expect(r.achou).toBe(true);
    expect(r.proxima).toBeNull();
    expect(r.alvos.map(a => a.campaignId)).toEqual([NA_FIXTURE]);
  });

  it("a campanha procurada entra no sistema de verdade", async () => {
    sync.startLocalRun({ procurar: NA_FIXTURE, activateCoupons: false });
    await sync.paginaLocal({ props: PROPS });
    expect(await coupons.getCoupon(NA_FIXTURE)).toBeTruthy();
  });

  it("campanha que não está na página: segue procurando na próxima", async () => {
    sync.startLocalRun({ procurar: "99999999", activateCoupons: false });
    const r = await sync.paginaLocal({ props: PROPS });
    expect(r.achou).toBe(false);
    expect(r.proxima.pagina).toBe(2);
  });

  it("o limite por categoria não interrompe uma busca antes da hora", () => {
    // Sem isto, `limitPerGrouping: 60` faria a busca desistir na página 2 — e a
    // campanha procurada pode estar na 12.
    const r = sync.startLocalRun({ procurar: NA_FIXTURE, limitPerGrouping: 5 });
    expect(r.config.limitPerGrouping).toBeGreaterThan(1000);
    expect(r.procurar).toBe(NA_FIXTURE);
  });

  // A busca não herda a config da rodada. São perguntas diferentes: a config diz o
  // que vale a pena COLHER, a busca diz onde a campanha PODE estar — e responder a
  // segunda com a primeira faz a busca dizer "não achei" para um cupom que estava
  // na lista. É a task 27: "como acha a campanha, mas não consegue puxar ela?".
  it("varre todas as categorias, mesmo com a config estreitada", () => {
    const r = sync.startLocalRun({ procurar: NA_FIXTURE, groupings: ["tb_vertical"] });
    expect(r.config.groupings).toEqual([]);
    // Uma categoria só, a "todas" — é o `grouping: null` do findCampaign do servidor.
    expect(r.proxima.grouping).toBeNull();
    expect(r.proxima.url).not.toContain("tb_vertical");
  });

  it("não descarta cupom de loja: a campanha procurada pode ser de uma", async () => {
    // 13474243 é um dos três cupons de loja da fixture. Com o `skipStoreCoupons`
    // ligado (que é o default), ele era descartado ANTES da comparação do id e a
    // busca respondia "não achei" para algo que estava na página.
    const DE_LOJA = "13474243";
    const r0 = sync.startLocalRun({ procurar: DE_LOJA, skipStoreCoupons: true, activateCoupons: false });
    expect(r0.config.skipStoreCoupons).toBe(false);
    const r = await sync.paginaLocal({ props: PROPS });
    expect(r.achou).toBe(true);
    expect(r.alvos.map(a => a.campaignId)).toEqual([DE_LOJA]);
    expect(await coupons.getCoupon(DE_LOJA)).toBeTruthy();
  });

  it("numa busca, o único cupom que pode ser ativado é o alvo", () => {
    // Fora de uma busca a mesma página rende 3 rótulos. Ativar é escrita
    // irreversível na conta: gastar o teto nos vizinhos deixaria justamente o alvo
    // sem o "Eu quero" — que é o único jeito de o ML revelar a vitrine dele.
    const ALVO_INATIVO = "13491809";
    sync.startLocalRun({ procurar: ALVO_INATIVO, activateCoupons: true, maxActivationsPerRun: 20 });
    const { labels } = sync.ativacoesLocais({ props: PROPS });
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/Saúde/);
  });

  it("conta as páginas varridas — é o que a tela mostra quando não acha", async () => {
    sync.startLocalRun({ procurar: "99999999", activateCoupons: false });
    expect((await sync.paginaLocal({ props: PROPS })).paginasLidas).toBe(1);
    expect((await sync.paginaLocal({ props: PROPS })).paginasLidas).toBe(2);
  });
});
