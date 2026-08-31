// Aba "Busca de Produtos" da campanha: lojas + categorias (limitadas pelo
// plano), filtros, preenchimento da fila (automático/manual) e a lista de
// produtos do catálogo com adição a dedo.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  browseCatalog: vi.fn(),
}));

import { browseCatalog } from "../data/api";
import ProductSearchTab, { SORT_OPTIONS } from "../components/campaign/ProductSearchTab.jsx";

function makeProduct(over = {}) {
  return {
    key: "k1", name: "Headset Gamer XYZ", link: "https://ml.com/p/1",
    price: 200, originalPrice: 400, discount: 50, store: "Mercado Livre",
    category: "gamer", rating: 4.5, img: null,
    ...over,
  };
}

// Wrapper com estado: a aba é controlada pelo GroupDashboard, e vários testes
// dependem do scraping/categorias mudarem de verdade.
// O bloco "Onde buscar" (lojas e categorias) fica fechado: a busca e a lista
// de produtos são o que abre à vista.
const abrirOnde = () => fireEvent.click(screen.getByRole("button", { name: /Escolher lojas e categorias/ }));

function Harness({
  initialScraping, initialCategories = ["gamer"], categoryLimit,
  onAddCatalogProduct = vi.fn(), lockMessageFor = () => null, ...rest
}) {
  const [scraping, setScraping] = useState(initialScraping || { auto: true, sources: ["Mercado Livre"], filters: {} });
  const [categories, setCategories] = useState(initialCategories);
  const toggleCategory = (id) => setCategories(c => (
    c.includes(id) ? (c.length === 1 ? c : c.filter(x => x !== id)) : [...c, id]
  ));
  const toggleSource = (src) => setScraping(s => ({
    ...s,
    sources: s.sources.includes(src) ? s.sources.filter(x => x !== src) : [...s.sources, src],
  }));
  return (
    <ProductSearchTab
      groupId={rest.groupId || "g1"}
      scraping={scraping}
      setScraping={setScraping}
      categories={categories}
      onToggleCategory={rest.onToggleCategory || toggleCategory}
      categoryLimit={categoryLimit}
      selectedSources={scraping.sources || []}
      onToggleSource={rest.onToggleSource || toggleSource}
      lockMessageFor={lockMessageFor}
      refilling={false}
      triggerRefill={rest.triggerRefill || vi.fn()}
      save={rest.save || vi.fn()}
      dirty={rest.dirty || false}
      saved={rest.saved || false}
      refillMsg={null}
      pending={rest.pending || []}
      queue={rest.queue || []}
      history={rest.history || []}
      cooldownMinutes={rest.cooldownMinutes || 0}
      onApprove={vi.fn()}
      onReject={vi.fn()}
      onApproveAll={vi.fn()}
      onRejectAll={vi.fn()}
      onAddCatalogProduct={onAddCatalogProduct}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Os blocos recolhíveis guardam aberto/fechado no localStorage.
  localStorage.clear();
  browseCatalog.mockResolvedValue({ items: [makeProduct()], total: 1, page: 1, pageSize: 24 });
});

describe("ProductSearchTab — lojas e categorias", () => {
  it("marca/desmarca loja e refaz a busca só com as lojas ativas", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalled());
    expect(browseCatalog.mock.calls[0][0].sources).toEqual(["Mercado Livre"]);

    abrirOnde();
    fireEvent.click(screen.getByRole("button", { name: /Amazon/ }));
    await waitFor(() => expect(browseCatalog.mock.calls.length).toBeGreaterThan(1));
    const last = browseCatalog.mock.calls[browseCatalog.mock.calls.length - 1][0];
    expect(last.sources).toEqual(["Mercado Livre", "Amazon"]);
  });

  it("loja trancada pelo admin aparece com cadeado e não entra na busca", async () => {
    render(<Harness
      initialScraping={{ auto: true, sources: ["Mercado Livre", "Shopee"], filters: {} }}
      lockMessageFor={(src) => (src === "Shopee" ? "Shopee em manutenção" : null)}
    />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalled());
    expect(browseCatalog.mock.calls[0][0].sources).toEqual(["Mercado Livre"]);
    abrirOnde();
    expect(screen.getByRole("button", { name: /🔒 Shopee/ })).toBeInTheDocument();
    expect(screen.getByText(/está indisponível no momento/)).toBeInTheDocument();
  });

  it("sem nenhuma loja ativa não chama o catálogo e explica o motivo", async () => {
    render(<Harness initialScraping={{ auto: true, sources: [], filters: {} }} />);
    expect(await screen.findByText(/Escolha ao menos uma loja disponível/)).toBeInTheDocument();
    expect(browseCatalog).not.toHaveBeenCalled();
  });

  it("só as categorias ligadas ficam à mostra; as outras vêm no botão Adicionar", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalled());
    abrirOnde();
    // "gamer" está ligada; "Casa" só existe depois de abrir o seletor.
    expect(screen.queryByRole("button", { name: /Casa/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Adicionar categoria/ }));
    expect(await screen.findByRole("button", { name: /Casa/ })).toBeInTheDocument();
  });

  it("o seletor marca várias e só o Confirmar muda a campanha", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalled());
    const antes = browseCatalog.mock.calls.length;

    abrirOnde();
    fireEvent.click(screen.getByRole("button", { name: /Adicionar categoria/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Casa/ }));
    fireEvent.click(screen.getByRole("button", { name: /Beleza/ }));
    // Marcar não mexe na campanha: nenhuma busca nova até confirmar.
    expect(browseCatalog.mock.calls.length).toBe(antes);

    fireEvent.click(screen.getByRole("button", { name: /Confirmar \(2\)/ }));
    await waitFor(() => expect(browseCatalog.mock.calls.length).toBeGreaterThan(antes));
    const last = browseCatalog.mock.calls[browseCatalog.mock.calls.length - 1][0];
    expect(last.categories).toEqual(expect.arrayContaining(["gamer", "casa", "beleza"]));
  });

  it("cancelar o seletor não adiciona nada", async () => {
    render(<Harness />);
    abrirOnde();
    fireEvent.click(await screen.findByRole("button", { name: /Adicionar categoria/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Casa/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Casa/ })).not.toBeInTheDocument());
  });

  it("no limite do plano, o seletor não deixa marcar mais e explica", async () => {
    render(<Harness initialCategories={["gamer"]} categoryLimit={2} />);
    abrirOnde();
    fireEvent.click(await screen.findByRole("button", { name: /Adicionar categoria/ }));
    // Cabe mais uma: depois de marcar, as outras ficam apagadas.
    fireEvent.click(await screen.findByRole("button", { name: /Casa/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Beleza/ })).toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: /Confirmar \(1\)/ }));
    expect(await screen.findByText(/limite de 2 categorias do seu plano/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Adicionar categoria/ })).toBeDisabled();
  });

  it("tira uma categoria pelo X, menos quando é a última", async () => {
    render(<Harness initialCategories={["gamer", "casa"]} />);
    abrirOnde();
    fireEvent.click(await screen.findByRole("button", { name: "Tirar Casa" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Tirar Casa" })).not.toBeInTheDocument());
    // Sobrou uma só: o X dela fica travado.
    expect(screen.getByRole("button", { name: /^Tirar / })).toBeDisabled();
  });

  it("o bloco Onde buscar abre no botão e mostra um resumo quando fechado", async () => {
    render(<Harness />);
    await screen.findByText(/Onde buscar/);
    // Fechado: nada de chips de loja, só o resumo.
    expect(screen.queryByRole("button", { name: /Amazon/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Mercado Livre · 1 categoria/)).toBeInTheDocument();

    abrirOnde();
    expect(screen.getByRole("button", { name: /Amazon/ })).toBeInTheDocument();
  });

  it("sem loja ativa o bloco Onde buscar já abre sozinho", async () => {
    render(<Harness initialScraping={{ auto: true, sources: [], filters: {} }} />);
    // É lá que está a correção — não faz sentido esconder.
    expect(await screen.findByRole("button", { name: /Amazon/ })).toBeInTheDocument();
    expect(screen.getByText(/Selecione ao menos uma loja/)).toBeInTheDocument();
  });

  it("a faixa de configuração fica no topo, antes da busca e da lista", async () => {
    const { container } = render(<Harness />);
    await screen.findByText("Headset Gamer XYZ");
    const ordem = [...container.querySelectorAll("[data-tour]")].map(el => el.dataset.tour);
    expect(ordem.indexOf("pr-where")).toBeLessThan(ordem.indexOf("pr-queue"));
    expect(ordem.indexOf("pr-queue")).toBeLessThan(ordem.indexOf("pr-search"));
    expect(ordem.indexOf("pr-search")).toBeLessThan(ordem.indexOf("pr-results"));
  });
});

describe("ProductSearchTab — filtros", () => {
  // Os filtros ficam fechados atrás do botão ao lado da busca.
  const abrirFiltros = () => fireEvent.click(screen.getByRole("button", { name: /^Filtros/ }));

  it("a busca por palavras-chave fica fora dos filtros, que abrem no botão ao lado", async () => {
    render(<Harness />);
    // Campo de busca sempre visível...
    expect(await screen.findByLabelText("Busca por palavras-chave")).toBeInTheDocument();
    // ...e o resto escondido até clicar em Filtros.
    expect(screen.queryByLabelText("Desconto mínimo")).not.toBeInTheDocument();

    abrirFiltros();
    expect(await screen.findByLabelText("Desconto mínimo")).toBeInTheDocument();

    abrirFiltros();
    await waitFor(() => expect(screen.queryByLabelText("Desconto mínimo")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Busca por palavras-chave")).toBeInTheDocument();
  });

  it("manda palavras-chave, preço, desconto, nota e vendas pro catálogo", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Busca por palavras-chave"), { target: { value: "headset, mouse" } });
    abrirFiltros();
    fireEvent.change(screen.getByLabelText("Preço mínimo"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Preço máximo"), { target: { value: "800" } });
    fireEvent.change(screen.getByLabelText("Desconto mínimo"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Avaliação mínima"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Vendas mínimas"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));

    await waitFor(() => {
      const last = browseCatalog.mock.calls[browseCatalog.mock.calls.length - 1][0];
      expect(last).toMatchObject({
        q: "headset, mouse", minPrice: 100, maxPrice: 800,
        minDiscount: 30, minRating: 4, minSales: 100,
      });
    });
  });

  it("mostra chips do que está filtrando, mesmo com o painel fechado, e limpa tudo", async () => {
    render(<Harness initialScraping={{
      auto: true, sources: ["Mercado Livre"],
      filters: { keywords: "monitor", minDiscount: 30, minSales: 100 },
    }} />);
    // A palavra-chave já está no campo, então não vira chip; os outros dois sim,
    // e o botão conta quantos estão ligados.
    expect(await screen.findByLabelText("Busca por palavras-chave")).toHaveValue("monitor");
    expect(screen.getByText(/30% ou mais de desconto/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Filtros 2/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Limpar filtros/ }));
    await waitFor(() => expect(screen.queryByText(/30% ou mais de desconto/)).not.toBeInTheDocument());
    expect(screen.getByLabelText("Busca por palavras-chave")).toHaveValue("");
  });

  it("aceita um número digitado à mão, fora da lista de sempre", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalled());

    abrirFiltros();
    fireEvent.change(screen.getByLabelText("Desconto mínimo"), { target: { value: "35" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));

    await waitFor(() => {
      const last = browseCatalog.mock.calls[browseCatalog.mock.calls.length - 1][0];
      expect(last.minDiscount).toBe(35);
    });
    expect(await screen.findByText(/35% ou mais de desconto/)).toBeInTheDocument();
  });

  it("nota acima de 5 encosta no teto ao sair do campo", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalled());

    abrirFiltros();
    const nota = screen.getByLabelText("Avaliação mínima");
    fireEvent.change(nota, { target: { value: "50" } });
    fireEvent.blur(nota, { target: { value: "50" } });
    // O que vale é o que vai pro catálogo quando se busca — o campo mostra o
    // teto junto, na mesma rodada.
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));

    await waitFor(() => {
      const last = browseCatalog.mock.calls[browseCatalog.mock.calls.length - 1][0];
      expect(last.minRating).toBe(5);
    });
    expect(nota).toHaveValue(5);
  });

  it("o painel de filtros não tem botão de salvar — grava sozinho", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalled());

    abrirFiltros();
    expect(screen.queryByRole("button", { name: /^Salvar/ })).not.toBeInTheDocument();
  });
});

// O que chega no catálogo: cada ordem da lista, o tamanho da página e os
// números que não podem passar do teto. É o contrato entre a aba e a rota
// /api/ofertas — se um id de ordenação mudar de nome só de um lado, cai aqui.
describe("ProductSearchTab — o que a aba pede ao catálogo", () => {
  const abrirFiltros = () => fireEvent.click(screen.getByRole("button", { name: /^Filtros/ }));
  const ultimaChamada = () => browseCatalog.mock.calls[browseCatalog.mock.calls.length - 1][0];

  it.each(SORT_OPTIONS.map(o => [o.id, o.label]))(
    "a ordem '%s' (%s) vai inteira pra busca",
    async (id) => {
      render(<Harness />);
      await waitFor(() => expect(browseCatalog).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Ordenar Por"), { target: { value: id } });
      await waitFor(() => expect(ultimaChamada().sortBy).toBe(id));
    },
  );

  it("pede a primeira página com 24 produtos", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalled());
    expect(ultimaChamada()).toMatchObject({ page: 1, pageSize: 24 });
  });

  it("desconto acima de 100% encosta no teto ao sair do campo", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalled());

    abrirFiltros();
    const desconto = screen.getByLabelText("Desconto mínimo");
    fireEvent.change(desconto, { target: { value: "300" } });
    fireEvent.blur(desconto, { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));

    await waitFor(() => expect(ultimaChamada().minDiscount).toBe(100));
    expect(desconto).toHaveValue(100);
  });

  it("vendas negativas viram sem mínimo", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalled());

    abrirFiltros();
    const vendas = screen.getByLabelText("Vendas mínimas");
    fireEvent.change(vendas, { target: { value: "-50" } });
    fireEvent.blur(vendas, { target: { value: "-50" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));

    await waitFor(() => expect(ultimaChamada().minSales).toBe(0));
  });

  it("avisa quando o preço mínimo passa do máximo", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalled());

    abrirFiltros();
    fireEvent.change(screen.getByLabelText("Preço mínimo"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("Preço máximo"), { target: { value: "100" } });
    expect(await screen.findByText(/preço mínimo está maior que o máximo/)).toBeInTheDocument();
  });

  it("trocar a ordem não leva junto o filtro que ainda não foi buscado", async () => {
    // A ordem vale na hora; o que está digitado só entra no Buscar. Se as duas
    // coisas saíssem juntas, mudar a ordem aplicaria um filtro pela metade.
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalled());

    abrirFiltros();
    fireEvent.change(screen.getByLabelText("Desconto mínimo"), { target: { value: "70" } });
    fireEvent.change(screen.getByLabelText("Ordenar Por"), { target: { value: "price_asc" } });

    await waitFor(() => expect(ultimaChamada().sortBy).toBe("price_asc"));
    expect(ultimaChamada().minDiscount).toBe(0);
  });
});

describe("ProductSearchTab — preenchimento automático", () => {
  // Os ajustes ficam atrás do "Configurar"; a chave de ligar/desligar não.
  const abrirConfig = () => fireEvent.click(screen.getByRole("button", { name: /Configurar/ }));

  it("a chave fica sempre à vista e os ajustes só no Configurar", async () => {
    render(<Harness />);
    expect(await screen.findByRole("switch", { name: "Preencher a fila automaticamente" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Produtos por vez")).not.toBeInTheDocument();

    abrirConfig();
    expect(await screen.findByLabelText("Produtos por vez")).toBeInTheDocument();

    abrirConfig();
    await waitFor(() => expect(screen.queryByLabelText("Produtos por vez")).not.toBeInTheDocument());
    expect(screen.getByRole("switch", { name: "Preencher a fila automaticamente" })).toBeInTheDocument();
    // O botão de preencher agora também não some junto
    expect(screen.getByRole("button", { name: /Preencher fila agora/ })).toBeInTheDocument();
  });

  it("liga/desliga o preenchimento automático", async () => {
    render(<Harness />);
    // Ligado por padrão (campanha antiga, sem o campo salvo)
    const chave = await screen.findByRole("switch", { name: "Preencher a fila automaticamente" });
    expect(chave).toHaveAttribute("aria-checked", "true");
    // A chave e o resumo ficam na faixa do topo, sem precisar abrir painel.
    expect(screen.getByText(/Automático quando faltarem/)).toBeInTheDocument();

    fireEvent.click(chave);
    await waitFor(() => expect(screen.getByText(/Automático desligado/)).toBeInTheDocument());
    expect(screen.getByRole("switch", { name: "Preencher a fila automaticamente" })).toHaveAttribute("aria-checked", "false");
  });

  it("o modo padrão é por fila acabando, com o número editável", async () => {
    render(<Harness />);
    abrirConfig();
    const campo = await screen.findByLabelText("Preencher quando faltarem menos de");
    expect(campo).toHaveValue(5);
    fireEvent.change(campo, { target: { value: "12" } });
    expect(screen.getByLabelText("Preencher quando faltarem menos de")).toHaveValue(12);
  });

  it("modo por horários: adiciona, edita e remove horário", async () => {
    render(<Harness />);
    abrirConfig();
    fireEvent.click(await screen.findByRole("button", { name: /Em horários do dia/ }));
    // Sem horário nenhum, avisa que não vai acontecer nada
    expect(await screen.findByText(/o preenchimento automático não vai acontecer/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Adicionar horário/ }));
    const campo = await screen.findByLabelText("Horário 1");
    expect(campo).toHaveValue("09:00");
    fireEvent.change(campo, { target: { value: "14:30" } });
    expect(screen.getByLabelText("Horário 1")).toHaveValue("14:30");

    fireEvent.click(screen.getByRole("button", { name: "Remover horário 1" }));
    await waitFor(() => expect(screen.queryByLabelText("Horário 1")).not.toBeInTheDocument());
  });

  it("preenchimento desligado esconde as opções de quando preencher", async () => {
    render(<Harness />);
    abrirConfig();
    fireEvent.click(await screen.findByRole("switch", { name: "Preencher a fila automaticamente" }));
    await waitFor(() => expect(screen.queryByLabelText("Preencher quando faltarem menos de")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Em horários do dia/ })).not.toBeInTheDocument();
  });

  it("não existe mais chave de aprovação automática", async () => {
    render(<Harness />);
    await screen.findByRole("switch", { name: "Preencher a fila automaticamente" });
    expect(screen.queryByRole("switch", { name: "Aprovação automática" })).not.toBeInTheDocument();
  });

  it("a opção de misturar depois de preencher fica no Configurar, desligada por padrão", async () => {
    render(<Harness />);
    await screen.findByRole("switch", { name: "Preencher a fila automaticamente" });
    expect(screen.queryByRole("switch", { name: /Misturar a fila/i })).not.toBeInTheDocument();
    abrirConfig();
    const sw = await screen.findByRole("switch", { name: /Misturar a fila/i });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(await screen.findByRole("switch", { name: /Misturar a fila/i })).toHaveAttribute("aria-checked", "true");
  });

  it("os pendentes não são mais revisados aqui — o aviso manda pra aba Fila", async () => {
    render(<Harness pending={[{ id: "p1", key: "p1", name: "Fone Pendente", store: "Amazon", price: 10, discount: 20 }]} />);
    expect(await screen.findByText(/aguardando revisão/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Adicionar todos à fila/ })).not.toBeInTheDocument();
  });

  it("a quantidade por vez aparece no botão de preencher", async () => {
    render(<Harness />);
    expect(await screen.findByRole("button", { name: /Preencher fila agora \(até 20\)/ })).toBeInTheDocument();
    abrirConfig();
    fireEvent.change(await screen.findByLabelText("Produtos por vez"), { target: { value: "5" } });
    expect(screen.getByRole("button", { name: /Preencher fila agora \(até 5\)/ })).toBeInTheDocument();
  });

  it("a ordem tem um seletor só, em cima da lista, e salva no scraping", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(1));
    // O painel de preenchimento não repete o campo: é o mesmo scraping.sortBy.
    abrirConfig();
    expect(screen.queryByLabelText("Ordem de escolha")).not.toBeInTheDocument();

    fireEvent.change(await screen.findByLabelText("Ordenar Por"), { target: { value: "rating_desc" } });
    await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(2));
    expect(browseCatalog.mock.calls[1][0].sortBy).toBe("rating_desc");
  });

  it("preencher fila agora pede confirmação antes de chamar o refill", async () => {
    const triggerRefill = vi.fn();
    render(<Harness triggerRefill={triggerRefill} />);
    fireEvent.click(await screen.findByRole("button", { name: /Preencher fila agora/ }));
    // O clique só abre o aviso — nada é buscado ainda.
    expect(triggerRefill).not.toHaveBeenCalled();
    const modal = screen.getByRole("dialog");
    expect(within(modal).getByText(/20 primeiros produtos/)).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole("button", { name: "Preencher agora" }));
    expect(triggerRefill).toHaveBeenCalled();
  });

  it("cancelar a confirmação não preenche a fila", async () => {
    const triggerRefill = vi.fn();
    render(<Harness triggerRefill={triggerRefill} />);
    fireEvent.click(await screen.findByRole("button", { name: /Preencher fila agora/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(triggerRefill).not.toHaveBeenCalled();
  });
});

describe("ProductSearchTab — lista de produtos", () => {
  it("lista os produtos e mostra o total", async () => {
    render(<Harness />);
    expect(await screen.findByText("Headset Gamer XYZ")).toBeInTheDocument();
    expect(screen.getByText(/1 no catálogo/)).toBeInTheDocument();
  });

  it("manda um produto do catálogo pra fila", async () => {
    const onAdd = vi.fn().mockResolvedValue({ ok: true, target: "queue" });
    render(<Harness onAddCatalogProduct={onAdd} />);
    fireEvent.click(await screen.findByRole("button", { name: "Adicionar à fila" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalled());
    expect(onAdd.mock.calls[0][0].link).toBe("https://ml.com/p/1");
    expect(await screen.findByText(/Foi pra fila/)).toBeInTheDocument();
  });

  it("produto em cooldown pede confirmação e reenvia com force", async () => {
    const onAdd = vi.fn()
      .mockResolvedValueOnce({ inCooldown: true })
      .mockResolvedValueOnce({ ok: true, target: "queue" });
    render(<Harness onAddCatalogProduct={onAdd} />);
    fireEvent.click(await screen.findByRole("button", { name: "Adicionar à fila" }));
    // O aviso nasce no card, no lugar do botão — não no topo da página.
    expect(await screen.findByText(/Já enviado há pouco/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adicionar à fila" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Adicionar assim mesmo" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
    expect(onAdd.mock.calls[1][1]).toBe(true);
  });

  it("cancelar a confirmação de reenvio devolve o botão de adicionar", async () => {
    const onAdd = vi.fn().mockResolvedValue({ inCooldown: true });
    render(<Harness onAddCatalogProduct={onAdd} />);
    fireEvent.click(await screen.findByRole("button", { name: "Adicionar à fila" }));
    fireEvent.click(await screen.findByRole("button", { name: "Não" }));
    expect(await screen.findByRole("button", { name: "Adicionar à fila" })).toBeInTheDocument();
  });

  it("produto que já está na fila só diz isso no lugar do botão", async () => {
    render(<Harness queue={[makeProduct()]} />);
    expect(await screen.findByRole("button", { name: "Já na fila" })).toBeDisabled();
    // O selo em cima do card sumiu: dizia a mesma coisa duas vezes.
    expect(screen.queryByText("Já está na fila")).not.toBeInTheDocument();
  });

  it("o 'Foi pra fila' ocupa o lugar do botão e depois vira 'Já na fila'", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // O queue chega depois, como no app: o GroupDashboard recarrega as ops.
      const onAdd = vi.fn().mockResolvedValue({ ok: true, target: "queue" });
      const { rerender } = render(<Harness onAddCatalogProduct={onAdd} />);
      fireEvent.click(await screen.findByRole("button", { name: "Adicionar à fila" }));

      // Enquanto a mensagem está na tela, não existe botão nenhum no card.
      expect(await screen.findByText(/Foi pra fila/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Já na fila|Adicionar à fila/ })).not.toBeInTheDocument();

      rerender(<Harness onAddCatalogProduct={onAdd} queue={[makeProduct()]} />);
      await vi.advanceTimersByTimeAsync(4100);
      await waitFor(() => expect(screen.queryByText(/Foi pra fila/)).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Já na fila" })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  // As duas chaves são filtro de BACKEND: o corte é feito no /api/ofertas (que
  // recebe o groupId), pra a página vir cheia em vez de encolher depois de
  // carregada. Por isso o que se testa aqui é o parâmetro que sai, não o card
  // que some — o mock devolve sempre a mesma lista.
  it("a chave 'Enviados recentemente' liga e desliga o hideRecent da busca", async () => {
    render(<Harness history={[makeProduct()]} cooldownMinutes={1440} cooldownLabel="1 dias" />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(1));
    // Desligada por padrão: o backend esconde os enviados há pouco.
    expect(browseCatalog.mock.calls[0][0].hideRecent).toBe(true);
    expect(browseCatalog.mock.calls[0][0].groupId).toBe("g1");

    fireEvent.click(screen.getByRole("switch", { name: "Mostrar enviados recentemente" }));
    await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(2));
    expect(browseCatalog.mock.calls[1][0].hideRecent).toBe(false);
  });

  it("a chave 'Já na fila' liga e desliga o hideQueued e volta pra primeira página", async () => {
    browseCatalog.mockResolvedValue({ items: [makeProduct()], total: 100, page: 1, pageSize: 24 });
    render(<Harness queue={[{ ...makeProduct(), link: "https://s.mercadolivre.com.br/abc" }]} />);
    // Ligada por padrão: os que já estão na fila aparecem, marcados.
    expect(await screen.findByRole("button", { name: "Já na fila" })).toBeDisabled();
    expect(browseCatalog.mock.calls[0][0].hideQueued).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Próxima →" }));
    await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(2));
    expect(browseCatalog.mock.calls[1][0].page).toBe(2);

    fireEvent.click(screen.getByRole("switch", { name: "Mostrar os que já estão na fila" }));
    await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(3));
    // Outra busca, outra lista: não faz sentido continuar na página 2.
    expect(browseCatalog.mock.calls[2][0]).toMatchObject({ hideQueued: true, page: 1 });
  });

  it("enviado fora do tempo de espera continua na lista e pode voltar pra fila", async () => {
    const antigo = { ...makeProduct(), sentAt: new Date(Date.now() - 5 * 86400000).toISOString() };
    render(<Harness history={[antigo]} cooldownMinutes={60} />);
    expect(await screen.findByText("Headset Gamer XYZ")).toBeInTheDocument();
    expect(screen.getByText("Já enviado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adicionar de novo" })).not.toBeDisabled();
  });
});

describe("ProductSearchTab — destaques do card", () => {
  it("mostra a loja do produto, o vendedor e quanto se economiza", async () => {
    browseCatalog.mockResolvedValue({
      items: [makeProduct({ seller: "Loja do Zé" })], total: 1, page: 1, pageSize: 24,
    });
    render(<Harness />);
    expect(await screen.findByText("Mercado Livre")).toBeInTheDocument();
    expect(screen.getByText("Loja do Zé")).toBeInTheDocument();
    // 400 → 200.
    expect(screen.getByText(/Economize R\$ 200,00/)).toBeInTheDocument();
  });

  it("com imagem, o desconto vira faixa e some do rodapé", async () => {
    browseCatalog.mockResolvedValue({
      items: [makeProduct({ img: "https://img/1.jpg" })], total: 1, page: 1, pageSize: 24,
    });
    render(<Harness />);
    // Um "-50%" só na tela: a faixa da imagem.
    await waitFor(() => expect(screen.getAllByText("-50%")).toHaveLength(1));
  });

  it("produto novo no catálogo ganha selo, produto antigo não", async () => {
    browseCatalog.mockResolvedValue({
      items: [makeProduct({ firstSeenAt: new Date(Date.now() - 3600 * 1000).toISOString() })],
      total: 1, page: 1, pageSize: 24,
    });
    const { unmount } = render(<Harness />);
    expect(await screen.findByText("Novo")).toBeInTheDocument();
    unmount();

    browseCatalog.mockResolvedValue({
      items: [makeProduct({ firstSeenAt: new Date(Date.now() - 5 * 86400000).toISOString() })],
      total: 1, page: 1, pageSize: 24,
    });
    render(<Harness />);
    await screen.findByText("Headset Gamer XYZ");
    expect(screen.queryByText("Novo")).not.toBeInTheDocument();
  });
});

describe("ProductSearchTab — busca por palavras-chave", () => {
  it("digitar não busca sozinho; Enter busca", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<Harness />);
      await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(1));

      const campo = screen.getByLabelText("Busca por palavras-chave");
      fireEvent.change(campo, { target: { value: "monitor" } });
      // Nada de debounce: por mais que se espere, a lista não se refaz sozinha.
      vi.advanceTimersByTime(2000);
      expect(browseCatalog).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/clique em Buscar/)).toBeInTheDocument();

      fireEvent.keyDown(campo, { key: "Enter" });
      await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(2));
      expect(browseCatalog.mock.calls[1][0]).toMatchObject({ q: "monitor" });

      vi.advanceTimersByTime(2000);
      expect(browseCatalog).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(/clique em Buscar/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("o botão Buscar manda o que está escrito", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Busca por palavras-chave"), { target: { value: "fone" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));

    await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(2));
    expect(browseCatalog.mock.calls[1][0]).toMatchObject({ q: "fone" });
  });

  it("a ordem não espera o Buscar — vale no clique", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Ordenar Por"), { target: { value: "price_asc" } });
    await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(2));
    expect(browseCatalog.mock.calls[1][0].sortBy).toBe("price_asc");
  });

  it("o ✕ limpa o campo de busca", async () => {
    render(<Harness />);
    const campo = await screen.findByLabelText("Busca por palavras-chave");
    fireEvent.change(campo, { target: { value: "monitor" } });

    fireEvent.click(screen.getByRole("button", { name: "Limpar a busca" }));
    expect(screen.getByLabelText("Busca por palavras-chave")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Limpar a busca" })).not.toBeInTheDocument();
  });
});

describe("ProductSearchTab — painéis que abrem em botão", () => {
  it("o resumo do preenchimento fica visível com o painel fechado", async () => {
    render(<Harness />);
    await screen.findByText("Headset Gamer XYZ");
    expect(screen.getByText(/Automático quando faltarem 5 na fila · 20 por vez/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Produtos por vez")).not.toBeInTheDocument();
  });

  it("aberto/fechado dos painéis fica guardado no navegador", async () => {
    const { unmount } = render(<Harness />);
    await screen.findByText("Headset Gamer XYZ");
    fireEvent.click(screen.getByRole("button", { name: /^Filtros/ }));
    abrirOnde();
    await screen.findByRole("button", { name: /Amazon/ });
    unmount();

    render(<Harness />);
    expect(await screen.findByRole("button", { name: /Amazon/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Desconto mínimo")).toBeInTheDocument();
  });

  it("os dois painéis da faixa não ficam abertos ao mesmo tempo", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: /Configurar/ }));
    expect(await screen.findByLabelText("Produtos por vez")).toBeInTheDocument();

    abrirOnde();
    expect(await screen.findByRole("button", { name: /Amazon/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Produtos por vez")).not.toBeInTheDocument();
  });

  it("Preencher fila agora continua à vista com os painéis fechados", async () => {
    render(<Harness />);
    await screen.findByText("Headset Gamer XYZ");
    expect(screen.queryByLabelText("Produtos por vez")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Preencher fila agora/ })).toBeEnabled();
  });
});

describe("ProductSearchTab — adicionar da lista", () => {
  const doisProdutos = [
    makeProduct(),
    makeProduct({ key: "k2", name: "Mouse ABC", link: "https://ml.com/p/2" }),
  ];

  it("adicionar um produto não trava o botão dos outros cards", async () => {
    // O primeiro add fica pendurado: o segundo card tem que continuar clicável.
    let solta;
    const onAdd = vi.fn(() => new Promise(res => { solta = () => res({ ok: true, target: "queue" }); }));
    browseCatalog.mockResolvedValue({ items: doisProdutos, total: 2, page: 1, pageSize: 24 });
    render(<Harness onAddCatalogProduct={onAdd} />);

    const botoes = await screen.findAllByRole("button", { name: "Adicionar à fila" });
    fireEvent.click(botoes[0]);
    await waitFor(() => expect(screen.getByText("Adicionando...")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Adicionar à fila" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Adicionar à fila" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
    solta();
  });

});

describe("ProductSearchTab — lista por páginas", () => {
  it("Próxima troca a página inteira, e o rodapé mostra em qual está", async () => {
    // 30 no total com página de 24 = duas páginas.
    browseCatalog
      .mockResolvedValueOnce({ items: [makeProduct()], total: 30, page: 1, pageSize: 24 })
      .mockResolvedValueOnce({ items: [makeProduct({ key: "k2", name: "Mouse ABC" })], total: 30, page: 2, pageSize: 24 });
    render(<Harness />);

    await screen.findByText("Headset Gamer XYZ");
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "← Anterior" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Próxima →" }));

    expect(await screen.findByText("Mouse ABC")).toBeInTheDocument();
    // Substitui, não acumula: a página 1 saiu da tela.
    expect(screen.queryByText("Headset Gamer XYZ")).not.toBeInTheDocument();
    expect(browseCatalog.mock.calls[1][0].page).toBe(2);
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Próxima →" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "← Anterior" })).not.toBeDisabled();
  });

  it("com uma página só, os controles não aparecem", async () => {
    render(<Harness />);
    await screen.findByText("Headset Gamer XYZ");
    expect(screen.queryByRole("button", { name: "Próxima →" })).not.toBeInTheDocument();
  });

  it("volta pra última página existente quando o total encolhe", async () => {
    browseCatalog
      .mockResolvedValueOnce({ items: [makeProduct()], total: 60, page: 1, pageSize: 24 })
      .mockResolvedValueOnce({ items: [makeProduct({ key: "k2", name: "Mouse ABC" })], total: 60, page: 2, pageSize: 24 })
      // Produtos entraram na fila: agora só cabe uma página.
      .mockResolvedValueOnce({ items: [makeProduct({ key: "k3", name: "Teclado QWE" })], total: 10, page: 3, pageSize: 24 })
      .mockResolvedValueOnce({ items: [makeProduct()], total: 10, page: 1, pageSize: 24 });
    render(<Harness />);

    await screen.findByText("Headset Gamer XYZ");
    fireEvent.click(screen.getByRole("button", { name: "Próxima →" }));
    await screen.findByText("Mouse ABC");
    fireEvent.click(screen.getByRole("button", { name: "Próxima →" }));

    await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(4));
    expect(browseCatalog.mock.calls[3][0].page).toBe(1);
  });

  it("erro do catálogo tem botão de tentar de novo", async () => {
    browseCatalog.mockRejectedValueOnce(new Error("Catálogo fora do ar"));
    render(<Harness />);

    expect(await screen.findByText("Catálogo fora do ar")).toBeInTheDocument();
    browseCatalog.mockResolvedValue({ items: [makeProduct()], total: 1, page: 1, pageSize: 24 });
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("Headset Gamer XYZ")).toBeInTheDocument();
  });

  it("lista vazia oferece tirar cada filtro, um a um", async () => {
    browseCatalog.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 24 });
    render(<Harness initialScraping={{
      auto: true, sources: ["Mercado Livre"], filters: { minDiscount: 70, minRating: 4 },
    }} />);

    expect(await screen.findByText(/Nenhum produto do catálogo passa nesses filtros/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Tirar 70% ou mais de desconto/ }));
    await waitFor(() => {
      const last = browseCatalog.mock.calls[browseCatalog.mock.calls.length - 1][0];
      expect(last.minDiscount).toBe(0);
      // O outro filtro continua de pé — era só o desconto que estava apertado.
      expect(last.minRating).toBe(4);
    });

    // Sobrou um filtro só: tirar tudo de uma vez deixa de fazer sentido.
    expect(screen.getByRole("button", { name: /Tirar nota 4\+/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Limpar todos os filtros" })).not.toBeInTheDocument();
  });
});

describe("ProductSearchTab — autosave", () => {
  it("não tem botão de salvar em lugar nenhum da aba", async () => {
    render(<Harness dirty />);
    await screen.findByText("Headset Gamer XYZ");
    expect(screen.queryByRole("button", { name: /^Salvar/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/alterações não salvas/)).not.toBeInTheDocument();
  });

  it("grava sozinho quando há alteração pendente e avisa que salvou", async () => {
    const save = vi.fn();
    const { rerender } = render(<Harness save={save} />);
    await screen.findByText("Headset Gamer XYZ");
    // Sem alteração pendente ninguém grava.
    expect(save).not.toHaveBeenCalled();

    rerender(<Harness dirty save={save} />);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });

    // O único retorno visual é o aviso discreto, que o dashboard apaga sozinho.
    rerender(<Harness save={save} saved />);
    expect(screen.getByText("✓ Salvo")).toBeInTheDocument();
  });
});
