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
//     escrita irreversível na conta do ML, e a extensão não pode palpitar. Desde a
//     task 28 a etapa 1 não ativa NINGUÉM: só uma busca (`procurar`) ou a etapa 2
//     dos produtos (`ativarApenas`) trazem alvos;
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
// O `app_config` é cache write-through em memória (backend/config/pg.js): o
// truncate entre testes limpa a TABELA, não o cache. E desde a task 14 a própria
// rodada aprende categorias e as grava aí — então um teste que não zera o
// dicionário herda o que o anterior descobriu.
const appConfig = require(path.join(backendDir, "config"));

const PROPS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "ml-cupons-filter.json"), "utf8"));

// A rodada é estado de módulo: uma que fica pendurada quebra a próxima.
// `await` porque o fim grava o que a rodada tinha lido — sem esperar, a gravação
// cairia no meio do truncate do teste seguinte.
beforeEach(async () => { if (sync.localAtivo()) await sync.fimLocalRun({ cancelada: true }); });
afterEach(async () => { if (sync.localAtivo()) await sync.fimLocalRun({ cancelada: true }); });

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
    const r = sync.startLocalRun({ categorias: [], limiteCupons: 5 });
    expect(r.proxima.url).toContain("mercadolivre.com.br/cupons/filter");
    expect(r.proxima.url).toContain("all=true");
    expect(r.proxima.pagina).toBe(1);
    expect(sync.status().running).toBe(true);
    expect(sync.status().local).toBe(true);
  });

  it("a etapa 1 é leitura pura: sem alvo, ela não ativa ninguém", () => {
    // É a separação em dois botões (task 28). Ativar é a única escrita que o
    // sistema faz na conta do ML, e ela foi toda para a etapa dos produtos —
    // é o que torna a varredura da lista segura de repetir.
    const r = sync.startLocalRun({ categorias: [], activateCoupons: true, maxActivationsPerRun: 20 });
    expect(r.ativa).toBe(false);
    expect(sync.ativacoesLocais({ props: PROPS }).labels).toEqual([]);
  });

  it("recusa a segunda rodada: as duas mexem na mesma conta do ML", () => {
    sync.startLocalRun({ limiteCupons: 5 });
    expect(() => sync.startLocalRun({})).toThrow(/rodada de cupons rodando/i);
  });
});

// A ETAPA 2 pedindo a ativação de uma lista de alvos. Os botões "Aplicar" só
// existem na lista do ML, então a etapa dos produtos passa por esta mesma
// varredura — só que clicando exclusivamente em quem ela nomeou.
describe("ativacoesLocais (a etapa 2 ativando os alvos)", () => {
  comORelogioDaFixture();

  // Os três não ativados de campanha da fixture.
  const TRES = ["13491809", "13999830", "13373945"];

  it("devolve só os rótulos que o aAtivar aprovou, e só dos alvos", () => {
    sync.startLocalRun({ ativarApenas: TRES, activateCoupons: true, maxActivationsPerRun: 20 });
    const { labels } = sync.ativacoesLocais({ grouping: null, props: PROPS });
    // Dos três, só um sai: 13999830 e 13373945 dividem o MESMO rótulo "Aplicar"
    // nesta página, e o aAtivar recusa os dois — não dá pra saber qual botão é de
    // qual, e um chute aqui é escrita irreversível na campanha errada.
    expect(labels).toEqual(["Aplicar cupom 10 por cento OFF Saúde Em produtos selecionados"]);
  });

  it("cupom fora da lista de alvos não é clicado", () => {
    // O vizinho na mesma página não pode gastar o teto: é escrita irreversível na
    // conta, e quem pediu a etapa 2 nomeou quem queria.
    sync.startLocalRun({ ativarApenas: [TRES[0]], activateCoupons: true, maxActivationsPerRun: 20 });
    expect(sync.ativacoesLocais({ props: PROPS }).labels).toHaveLength(1);
  });

  it("o teto de ativações da rodada é respeitado", () => {
    sync.startLocalRun({ ativarApenas: TRES, activateCoupons: true, maxActivationsPerRun: 1 });
    expect(sync.ativacoesLocais({ props: PROPS }).labels).toHaveLength(1);
  });

  it("com a ativação desligada, ninguém é clicado", () => {
    sync.startLocalRun({ ativarApenas: TRES, activateCoupons: false });
    expect(sync.ativacoesLocais({ props: PROPS }).labels).toEqual([]);
  });

  it("gasto o teto, não sobra ativação para a página seguinte", async () => {
    sync.startLocalRun({ ativarApenas: TRES, activateCoupons: true, maxActivationsPerRun: 1 });
    expect(sync.ativacoesLocais({ props: PROPS }).labels).toHaveLength(1);
    await sync.paginaLocal({ props: PROPS, ativados: 1 });
    expect(sync.ativacoesLocais({ props: PROPS }).labels).toEqual([]);
  });
});

describe("paginaLocal", () => {
  it("pede a próxima página enquanto a lista rende e o teto não chegou", async () => {
    sync.startLocalRun({ limiteCupons: 200, carimbarCategorias: false });
    const r = await sync.paginaLocal({ grouping: null, props: PROPS });
    // Os 8 da fixture, os 3 de loja INCLUSOS: desde a task 28 eles entram e são
    // separados na tela, em vez de descartados.
    expect(r.cupons).toBe(8);
    expect(r.ignoradosLoja).toBe(0);
    expect(r.de).toBe(13);
    expect(r.proxima.pagina).toBe(2);
    // Os produtos são a etapa 2, num botão separado: a varredura da lista não
    // devolve mais vitrine para a tela sair colhendo.
    expect(r.alvos).toBeNull();
  });

  it("com o descarte ligado, o cupom de loja sai antes de entrar", async () => {
    sync.startLocalRun({ limiteCupons: 200, carimbarCategorias: false, skipStoreCoupons: true });
    const r = await sync.paginaLocal({ props: PROPS });
    expect(r.cupons).toBe(5);
    expect(r.ignoradosLoja).toBe(3);
  });

  it("batido o teto de cupons, a varredura acaba e os cupons são gravados", async () => {
    sync.startLocalRun({ limiteCupons: 3, carimbarCategorias: false });
    const r = await sync.paginaLocal({ grouping: null, props: PROPS });
    expect(r.proxima).toBeNull();
    expect(r.resumo.cupons).toBe(3);
    // Gravou de verdade: é isto que o `gravarVitrineLocal` da etapa 2 exige, e é o
    // que sobra se o Chrome fechar no meio.
    expect(await coupons.getCoupon("13491809")).toBeTruthy();
  });

  it("teto zero quer dizer 'todos', e não 'nenhum'", async () => {
    sync.startLocalRun({ limiteCupons: 0, carimbarCategorias: false });
    const r = await sync.paginaLocal({ props: PROPS });
    expect(r.cupons).toBe(8);
    expect(r.proxima.pagina).toBe(2);
  });

  it("o teto de páginas da lista geral encerra a varredura", async () => {
    sync.startLocalRun({ limiteCupons: 0, maxPaginasLista: 1, carimbarCategorias: false });
    const r = await sync.paginaLocal({ props: PROPS });
    expect(r.proxima).toBeNull();
    expect(r.resumo.avisos.join(" ")).toMatch(/teto de 1 páginas/i);
  });

  it("a lista que pagina em círculo não vira varredura infinita", async () => {
    sync.startLocalRun({ limiteCupons: 200, carimbarCategorias: false });
    // A mesma página, repetida: o ML começou a devolver o que já veio. A varredura
    // desiste depois de MAX_PAGINAS_SEM_NOVIDADE — a lista do ML às vezes pagina
    // em círculo.
    let r = null;
    for (let i = 0; i < 10 && (!r || r.proxima); i++) r = await sync.paginaLocal({ props: PROPS });
    expect(r.proxima).toBeNull();
    expect(r.resumo.cupons).toBe(8);
  });

  it("página sem cupom nenhum encerra em vez de insistir", async () => {
    sync.startLocalRun({ limiteCupons: 200, carimbarCategorias: false });
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
    sync.startLocalRun({ limiteCupons: 3, carimbarCategorias: false });
    await sync.paginaLocal({ props: PROPS });
    const { resumo } = await sync.fimLocalRun({ vitrines: 2, produtos: 40 });
    expect(resumo.cupons).toBe(3);
    expect(resumo.cuponsComVitrine).toBe(2);
    expect(resumo.vinculos).toBe(40);
    expect(resumo.origem).toBe("extensao");
    // Sem isto o /run e o "Apagar todos" recusariam para sempre.
    expect(sync.status().running).toBe(false);
    expect(sync.localAtivo()).toBe(false);
  });

  it("a rodada abandonada no meio expira sozinha em vez de travar a próxima", () => {
    sync.startLocalRun({ limiteCupons: 3 });
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
// Task 28: a COLETA é a lista geral, e as verticais vêm depois só para CARIMBAR a
// categoria. É o meio-termo entre os dois erros: sem a geral, cupom que não está
// em vertical nenhuma nunca entra (era a task 26 ao contrário); sem as verticais,
// tudo entra sem categoria, porque o ML não diz a vertical do cupom na lista — a
// categoria que o sistema grava é o filtro que a varredura pediu na URL.
describe("startLocalRun: a lista geral e o carimbo por categoria", () => {
  beforeEach(() => {
    appConfig.del("ml-cupons-groupings");
    // O dicionário de nomes é o que diz quais categorias existem NO COMEÇO da
    // rodada. Junto das verticais vêm duas chaves que NÃO são categoria — são
    // filtros do ML. A fixture traz o `availableGroupingsKeys` completo, então a
    // rodada descobre as outras sete na primeira página (ver o teste da descoberta).
    sync.mergeGroupingLabels([
      { key: "ce_vertical", title: "Eletrônicos, Áudio e Vídeo" },
      { key: "fa_vertical", title: "Moda e acessórios" },
      { key: "tb_vertical", title: "Brinquedos, Hobbies e Bebês" },
      { key: "price", title: "Mais de R$100" },
      { key: "percentage", title: "Mais de 10%" },
    ]);
  });

  it("começa pela lista geral e só depois passa nas verticais", () => {
    const r = sync.startLocalRun({ categorias: [] });
    expect(r.categorias).toEqual([null, "ce_vertical", "fa_vertical", "tb_vertical"]);
    expect(r.proxima.grouping).toBeNull();
    expect(r.proxima.url).toContain("all=true");
    expect(r.proxima.url).not.toContain("_vertical=true");
  });

  it("acabada a lista geral, a próxima página é a da primeira vertical", async () => {
    // `maxPaginasLista: 1` encerra a coleta na primeira página, então a varredura
    // vira para o carimbo em vez de terminar.
    sync.startLocalRun({ categorias: [], maxPaginasLista: 1 });
    const r = await sync.paginaLocal({ grouping: null, props: PROPS });
    expect(r.proxima).not.toBeNull();
    expect(r.proxima.grouping).toBe("ce_vertical");
    expect(r.proxima.pagina).toBe(1);
  });

  it("o teto de cupons não corta a passada de carimbo", async () => {
    // O carimbo não é colheita: cortar ele pelo teto deixaria metade dos cupons
    // sem categoria justamente na rodada em que o teto foi apertado.
    sync.startLocalRun({ categorias: [], limiteCupons: 3, maxPaginasPorCategoria: 1 });
    const geral = await sync.paginaLocal({ grouping: null, props: PROPS });
    expect(geral.proxima.grouping).toBe("ce_vertical");
    const carimbo = await sync.paginaLocal({ grouping: "ce_vertical", props: PROPS });
    expect(carimbo.cupons).toBe(8);
  });

  it("o cupom entra carimbado com a UNIÃO das verticais em que apareceu", async () => {
    sync.startLocalRun({ categorias: [], maxPaginasLista: 1, maxPaginasPorCategoria: 1, carimboCompleto: true });
    // A mesma fixture na geral e em cada vertical: o cupom aparece em todas, e a
    // varredura tem de guardar a união delas, não a última. São dez porque a
    // rodada descobriu as sete que faltavam na primeira página (task 14).
    let r = null;
    while (!r || r.proxima) r = await sync.paginaLocal({ grouping: r ? r.proxima.grouping : null, props: PROPS });
    const guardado = await coupons.getCoupon("13491809");
    expect(guardado.groupings.sort()).toEqual([
      "acc_vertical", "as_vertical", "bh_vertical", "ce_vertical", "cpg_vertical",
      "et_vertical", "fa_vertical", "hi_vertical", "ot_vertical", "tb_vertical",
    ]);
  });
});

// Task 14: a fila de categorias era montada só com o que o dicionário já sabia, e
// nada em produção escrevia nesse dicionário desde o commit 37a81d0 — ele estava
// congelado em três verticais havia meses, e como só se aprende uma vertical
// VISITANDO-A, a rodada nunca sairia dali sozinha. O ML manda a lista completa em
// toda página de `/cupons/filter`; é de lá que ela sai agora.
describe("a rodada descobre as categorias que o ML mostra", () => {
  beforeEach(() => { appConfig.del("ml-cupons-groupings"); });

  it("a fila cresce na primeira página da lista geral, não na rodada seguinte", async () => {
    // O dicionário congelado da conta real: três verticais e dois filtros.
    sync.mergeGroupingLabels([
      { key: "ce_vertical", title: "Eletrônicos, Áudio e Vídeo" },
      { key: "fa_vertical", title: "Moda e acessórios" },
      { key: "tb_vertical", title: "Brinquedos, Hobbies e Bebês" },
      { key: "price", title: "Mais de R$100" },
      { key: "percentage", title: "Mais de 10%" },
    ]);
    const inicio = sync.startLocalRun({ categorias: [], maxPaginasLista: 1 });
    expect(inicio.categorias).toEqual([null, "ce_vertical", "fa_vertical", "tb_vertical"]);

    await sync.paginaLocal({ grouping: null, props: PROPS });

    // As sete que faltavam entraram na fila DESTA rodada.
    const dicionario = sync.readGroupingLabels();
    for (const k of ["hi_vertical", "as_vertical", "bh_vertical", "acc_vertical", "cpg_vertical", "et_vertical", "ot_vertical"]) {
      expect(dicionario).toHaveProperty(k);
    }
    expect(sync.verticaisConhecidas()).toHaveLength(10);
  });

  it("filtro não vira categoria: price e percentage entram no dicionário e ficam fora da fila", async () => {
    sync.startLocalRun({ categorias: [], maxPaginasLista: 1 });
    await sync.paginaLocal({ grouping: null, props: PROPS });
    // Eles vêm na mesma lista do ML e são guardados (a tela mostra o nome deles em
    // cupom antigo), mas varrer por eles carimbaria "Mais de 10%" na coluna
    // Categoria — que não é categoria nenhuma.
    expect(sync.readGroupingLabels()).toHaveProperty("percentage");
    expect(sync.verticaisConhecidas()).not.toContain("percentage");
    expect(sync.verticaisConhecidas()).not.toContain("price");
  });

  it("categoria escolhida na tela manda: a descoberta não atropela a escolha", async () => {
    sync.startLocalRun({ categorias: ["fa_vertical"], maxPaginasLista: 1 });
    const r = await sync.paginaLocal({ grouping: null, props: PROPS });
    // O dicionário aprende do mesmo jeito (a tela precisa das caixas), mas a fila
    // continua sendo a que o Allan pediu.
    expect(sync.verticaisConhecidas().length).toBeGreaterThan(1);
    expect(r.proxima.grouping).toBe("fa_vertical");
    let ultimo = r;
    while (ultimo.proxima) ultimo = await sync.paginaLocal({ grouping: ultimo.proxima.grouping, props: PROPS });
    const guardado = await coupons.getCoupon("13491809");
    expect(guardado.groupings).toEqual(["fa_vertical"]);
  });

  it("buscar UMA campanha não vira dez varreduras", async () => {
    sync.startLocalRun({ procurar: "99999999", activateCoupons: false, maxPaginasLista: 1 });
    const r = await sync.paginaLocal({ grouping: null, props: PROPS });
    // A lista geral já contém tudo: descobrir categoria aqui só custaria navegação
    // com a conta do sistema atrás do mesmo cupom.
    expect(r.proxima).toBeNull();
  });
});

// A outra metade da task 14: mesmo varrendo as dez verticais, o carimbo morria na
// quinta página de cada uma. `juntarCupom` devolvia "não é novo" para o cupom que
// tinha ACABADO de ganhar categoria, o contador de páginas sem novidade enchia e a
// vertical era cortada — independente do `maxPaginasPorCategoria`.
describe("o carimbo vai fundo na vertical", () => {
  beforeEach(() => {
    appConfig.del("ml-cupons-groupings");
    sync.mergeGroupingLabels([{ key: "ce_vertical", title: "Eletrônicos" }]);
  });

  it("carimbar conta como novidade: a vertical não morre na quinta página", async () => {
    sync.startLocalRun({ categorias: ["ce_vertical"], maxPaginasLista: 1, maxPaginasPorCategoria: 10, carimboCompleto: true });
    let r = await sync.paginaLocal({ grouping: null, props: PROPS });
    expect(r.proxima.grouping).toBe("ce_vertical");

    // A MESMA página, repetida: nenhum cupom é novo, mas a primeira volta carimba
    // `ce_vertical` em todos. Antes, cinco páginas assim encerravam a vertical.
    const primeira = await sync.paginaLocal({ grouping: "ce_vertical", props: PROPS });
    expect(primeira.novos).toBe(0);
    expect(primeira.carimbados).toBeGreaterThan(0);
    expect(primeira.proxima.pagina).toBe(2);
  });

  it("sem carimbo novo por cinco páginas, aí sim a vertical acaba", async () => {
    // O freio continua existindo — o que mudou é o que conta como progresso.
    sync.startLocalRun({ categorias: ["ce_vertical"], maxPaginasLista: 1, maxPaginasPorCategoria: 50, carimboCompleto: true });
    await sync.paginaLocal({ grouping: null, props: PROPS });
    let r = null;
    let voltas = 0;
    do {
      r = await sync.paginaLocal({ grouping: "ce_vertical", props: PROPS });
      voltas++;
    } while (r.proxima?.grouping === "ce_vertical" && voltas < 20);
    // 1 página que carimba + 5 sem novidade nenhuma.
    expect(voltas).toBe(6);
  });

  it("o teto de páginas por categoria agora faz o que promete", async () => {
    sync.startLocalRun({ categorias: ["ce_vertical"], maxPaginasLista: 1, maxPaginasPorCategoria: 2, carimboCompleto: true });
    await sync.paginaLocal({ grouping: null, props: PROPS });
    const p1 = await sync.paginaLocal({ grouping: "ce_vertical", props: PROPS });
    expect(p1.proxima.pagina).toBe(2);
    const p2 = await sync.paginaLocal({ grouping: "ce_vertical", props: PROPS });
    expect(p2.proxima).toBeNull();
  });
});

// O carimbo incremental. A lista geral é lida inteira em toda rodada (é ela que
// traz as condições), mas as verticais existem só para descobrir a categoria — e
// o banco já sabe a de todo cupom carimbado antes. Sem isto a segunda rodada
// demorava o mesmo que a primeira: a conta inteira relida uma vez por vertical.
describe("o carimbo só procura o que ainda não tem categoria", () => {
  beforeEach(() => {
    appConfig.del("ml-cupons-groupings");
    sync.mergeGroupingLabels([
      { key: "ce_vertical", title: "Eletrônicos" },
      { key: "fa_vertical", title: "Moda e acessórios" },
    ]);
  });

  // Uma rodada completa antes: todos os cupons da fixture ficam carimbados no banco.
  async function rodadaAnterior() {
    sync.startLocalRun({ categorias: ["ce_vertical"], maxPaginasLista: 1, maxPaginasPorCategoria: 1, carimboCompleto: true });
    let r = null;
    while (!r || r.proxima) r = await sync.paginaLocal({ grouping: r ? r.proxima.grouping : null, props: PROPS });
    await sync.fimLocalRun();
  }

  it("com tudo carimbado no banco, a rodada acaba na lista geral", async () => {
    await rodadaAnterior();
    sync.startLocalRun({ categorias: ["ce_vertical", "fa_vertical"], maxPaginasLista: 1 });
    const r = await sync.paginaLocal({ grouping: null, props: PROPS });
    expect(r.proxima).toBeNull();
    // E a categoria que já estava lá continua lá.
    expect((await coupons.getCoupon("13491809")).groupings).toEqual(["ce_vertical"]);
  });

  it("com cupom sem categoria, as verticais param assim que o último é achado", async () => {
    sync.startLocalRun({ categorias: ["ce_vertical", "fa_vertical"], maxPaginasLista: 1, maxPaginasPorCategoria: 10 });
    const geral = await sync.paginaLocal({ grouping: null, props: PROPS });
    expect(geral.proxima.grouping).toBe("ce_vertical");
    // A primeira página da vertical carimba os oito: nem a página 2, nem fa_vertical.
    const p1 = await sync.paginaLocal({ grouping: "ce_vertical", props: PROPS });
    expect(p1.proxima).toBeNull();
    expect((await coupons.getCoupon("13491809")).groupings).toEqual(["ce_vertical"]);
  });

  it("\"Buscar TUDO\" refaz o carimbo inteiro mesmo com tudo no banco", async () => {
    await rodadaAnterior();
    sync.startLocalRun({ categorias: ["ce_vertical", "fa_vertical"], tudo: true, maxPaginasPorCategoria: 1 });
    // O `tudo` solta o teto da lista geral; a fixture diz 13 páginas, e a mesma
    // página repetida esgota o freio de "sem novidade" antes disso.
    let r = await sync.paginaLocal({ grouping: null, props: PROPS });
    while (r.proxima?.grouping === null) r = await sync.paginaLocal({ grouping: null, props: PROPS });
    expect(r.proxima.grouping).toBe("ce_vertical");
  });
});

// A terceira: a rodada passou de quatro entradas na fila para onze, e nada ia pro
// banco antes da última página da última vertical. Um muro do ML, uma aba fechada
// ou o watchdog no meio jogavam a rodada inteira fora.
describe("a rodada grava a cada categoria, não só no fim", () => {
  beforeEach(() => {
    appConfig.del("ml-cupons-groupings");
    sync.mergeGroupingLabels([{ key: "ce_vertical", title: "Eletrônicos" }]);
  });

  it("acabada a lista geral, os cupons já estão no banco", async () => {
    sync.startLocalRun({ categorias: ["ce_vertical"], maxPaginasLista: 1, maxPaginasPorCategoria: 1 });
    const r = await sync.paginaLocal({ grouping: null, props: PROPS });
    // Ainda tem fila pela frente...
    expect(r.proxima.grouping).toBe("ce_vertical");
    // ...e o que já foi colhido sobrevive a uma interrupção daqui pra frente.
    expect(await coupons.getCoupon("13491809")).toBeTruthy();
    await sync.fimLocalRun({ cancelada: true });
    expect(await coupons.getCoupon("13491809")).toBeTruthy();
  });
});

// A etapa 2 em LOTES. A última varredura de verdade (21/09/2026) foi interrompida
// na ativação e não deixou NADA no banco: a lista de alvos é uma categoria só, a
// gravação só acontecia na última página, e o cancelamento só soltava a rodada.
describe("interromper não joga fora o que foi lido", () => {
  comORelogioDaFixture();

  it("Parar no meio da lista geral grava os cupons já lidos", async () => {
    sync.startLocalRun({ limiteCupons: 0, carimbarCategorias: false });
    const r = await sync.paginaLocal({ grouping: null, props: PROPS });
    expect(r.proxima).toBeTruthy();
    expect(await coupons.getCoupon("13491809")).toBeFalsy();

    const fim = await sync.fimLocalRun({ cancelada: true });
    expect(fim.resumo.salvos).toBe(8);
    expect(await coupons.getCoupon("13491809")).toBeTruthy();
    expect(sync.localAtivo()).toBe(false);
  });

  it("na ativação, os alvos são gravados na página em que aparecem", async () => {
    // Um alvo desta página e um que não está nela: a varredura segue, mas o que
    // apareceu já está no banco — um Parar daqui em diante não perde o clique.
    sync.startLocalRun({ ativarApenas: ["13491809", "999999999"], activateCoupons: true });
    const r = await sync.paginaLocal({ grouping: null, props: PROPS, ativados: 1 });
    expect(r.salvosNestaPagina).toBe(1);
    expect(r.salvosTotal).toBe(1);
    expect(r.proxima).toBeTruthy();
    expect(await coupons.getCoupon("13491809")).toBeTruthy();
  });

  it("vistos todos os alvos do lote, a varredura acaba sem ler o resto da lista", async () => {
    sync.startLocalRun({ ativarApenas: ["13491809", "14094436"], activateCoupons: true });
    const r = await sync.paginaLocal({ grouping: null, props: PROPS });
    expect(r.proxima).toBeNull();
    expect(r.salvosTotal).toBe(2);
  });

  it("a config do tamanho do lote é clampada", async () => {
    expect((await sync.writeConfig({ tamanhoLoteProdutos: 0 })).tamanhoLoteProdutos).toBe(1);
    expect((await sync.writeConfig({ tamanhoLoteProdutos: 9999 })).tamanhoLoteProdutos).toBe(200);
    expect((await sync.alvosDeProdutos()).config.tamanhoLoteProdutos).toBe(200);
    await sync.writeConfig({ tamanhoLoteProdutos: 20 });
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

  it("o teto de cupons não interrompe uma busca antes da hora", () => {
    // Sem isto, `limiteCupons: 5` faria a busca desistir na página 1 — e a
    // campanha procurada pode estar na 12.
    const r = sync.startLocalRun({ procurar: NA_FIXTURE, limiteCupons: 5 });
    expect(r.config.limiteCupons).toBe(0);
    expect(r.procurar).toBe(NA_FIXTURE);
  });

  // A busca não herda a config da rodada. São perguntas diferentes: a config diz o
  // que vale a pena COLHER, a busca diz onde a campanha PODE estar — e responder a
  // segunda com a primeira faz a busca dizer "não achei" para um cupom que estava
  // na lista. É a task 27: "como acha a campanha, mas não consegue puxar ela?".
  it("é a lista geral, mesmo com a config estreitada numa vertical", () => {
    const r = sync.startLocalRun({ procurar: NA_FIXTURE, categorias: ["tb_vertical"] });
    expect(r.categorias).toEqual([null]);
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
