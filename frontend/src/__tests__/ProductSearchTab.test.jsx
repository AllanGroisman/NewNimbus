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
import ProductSearchTab from "../components/campaign/ProductSearchTab.jsx";

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
      saved={false}
      saveBtnStyle={() => ({})}
      refillMsg={null}
      pending={rest.pending || []}
      queue={rest.queue || []}
      history={rest.history || []}
      cooldownMinutes={rest.cooldownMinutes || 0}
      cooldownLabel={rest.cooldownLabel}
      onApprove={vi.fn()}
      onReject={vi.fn()}
      onApproveAll={vi.fn()}
      onRejectAll={vi.fn()}
      onAddCatalogProduct={onAddCatalogProduct}
      onAddCatalogProducts={rest.onAddCatalogProducts}
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

  it("trocar a ordem de escolha salva no scraping e refaz a busca", async () => {
    render(<Harness />);
    await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(1));
    abrirConfig();
    fireEvent.change(await screen.findByLabelText("Ordem de escolha"), { target: { value: "rating_desc" } });
    await waitFor(() => expect(browseCatalog).toHaveBeenCalledTimes(2));
    expect(browseCatalog.mock.calls[1][0].sortBy).toBe("rating_desc");
    // O seletor da lista mostra a mesma ordem
    expect(screen.getByLabelText("Ordenar a lista")).toHaveValue("rating_desc");
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

  it("produto que já está na fila aparece marcado e sem botão ativo", async () => {
    render(<Harness queue={[makeProduct()]} />);
    expect(await screen.findByText("Já está na fila")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Já na fila" })).toBeDisabled();
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

  it("esconde os enviados dentro do tempo de espera e mostra quando pedido", async () => {
    // O histórico guarda o link JÁ AFILIADO — o encontro é pela key, senão a
    // chave não escondia nada.
    const enviado = { ...makeProduct(), link: "https://s.mercadolivre.com.br/abc", sentAt: new Date().toISOString() };
    render(<Harness history={[enviado]} cooldownMinutes={1440} cooldownLabel="1 dias" />);
    expect(await screen.findByText(/1 enviado há pouco/)).toBeInTheDocument();
    expect(screen.queryByText("Headset Gamer XYZ")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Mostrar enviados recentemente" }));
    expect(await screen.findByText("Headset Gamer XYZ")).toBeInTheDocument();
    expect(screen.getByText("Enviado há pouco")).toBeInTheDocument();
  });

  it("a chave 'Já na fila' esconde e mostra os produtos que já estão na campanha", async () => {
    render(<Harness queue={[{ ...makeProduct(), link: "https://s.mercadolivre.com.br/abc" }]} />);
    // Por padrão eles aparecem, marcados.
    expect(await screen.findByText("Já está na fila")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Mostrar os que já estão na fila" }));
    await waitFor(() => expect(screen.queryByText("Headset Gamer XYZ")).not.toBeInTheDocument());
    expect(screen.getByText(/1 já na fila desta campanha/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Mostrar os que já estão na fila" }));
    expect(await screen.findByText("Headset Gamer XYZ")).toBeInTheDocument();
  });

  it("enviado fora do tempo de espera continua na lista e pode voltar pra fila", async () => {
    const antigo = { ...makeProduct(), sentAt: new Date(Date.now() - 5 * 86400000).toISOString() };
    render(<Harness history={[antigo]} cooldownMinutes={60} />);
    expect(await screen.findByText("Headset Gamer XYZ")).toBeInTheDocument();
    expect(screen.getByText("Já enviado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adicionar de novo" })).not.toBeDisabled();
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

describe("ProductSearchTab — adicionar vários de uma vez", () => {
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

  it("seleciona dois e manda os dois de uma vez pro handler de lote", async () => {
    const onBulk = vi.fn().mockResolvedValue({ added: 2, duplicates: 0, cooldown: [], errors: [] });
    browseCatalog.mockResolvedValue({ items: doisProdutos, total: 2, page: 1, pageSize: 24 });
    render(<Harness onAddCatalogProducts={onBulk} />);

    fireEvent.click(await screen.findByLabelText("Selecionar Headset Gamer XYZ"));
    fireEvent.click(screen.getByLabelText("Selecionar Mouse ABC"));

    fireEvent.click(screen.getByRole("button", { name: "Adicionar 2 à fila" }));
    await waitFor(() => expect(onBulk).toHaveBeenCalledTimes(1));
    expect(onBulk.mock.calls[0][0].map(p => p.key)).toEqual(["k1", "k2"]);
    expect(await screen.findByText(/2 adicionados/)).toBeInTheDocument();
  });

  it("o que caiu no tempo de espera fica num aviso só, com reenvio em lote", async () => {
    const onBulk = vi.fn()
      .mockResolvedValueOnce({ added: 1, duplicates: 0, cooldown: [doisProdutos[1]], errors: [] })
      .mockResolvedValueOnce({ added: 1, duplicates: 0, cooldown: [], errors: [] });
    browseCatalog.mockResolvedValue({ items: doisProdutos, total: 2, page: 1, pageSize: 24 });
    render(<Harness onAddCatalogProducts={onBulk} cooldownLabel="1 dia" />);

    fireEvent.click(await screen.findByLabelText("Selecionar todos os produtos da lista"));
    fireEvent.click(screen.getByRole("button", { name: "Adicionar 2 à fila" }));

    expect(await screen.findByText(/1 produto foi enviado há pouco/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Adicionar assim mesmo" }));
    await waitFor(() => expect(onBulk).toHaveBeenCalledTimes(2));
    // Segunda rodada só com o que faltou, e forçando.
    expect(onBulk.mock.calls[1][0].map(p => p.key)).toEqual(["k2"]);
    expect(onBulk.mock.calls[1][1]).toBe(true);
  });
});

describe("ProductSearchTab — lista carregada aos poucos", () => {
  it("Carregar mais acumula a página seguinte sem apagar a primeira", async () => {
    browseCatalog
      .mockResolvedValueOnce({ items: [makeProduct()], total: 2, page: 1, pageSize: 1 })
      .mockResolvedValueOnce({ items: [makeProduct({ key: "k2", name: "Mouse ABC" })], total: 2, page: 2, pageSize: 1 });
    render(<Harness />);

    await screen.findByText("Headset Gamer XYZ");
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));

    expect(await screen.findByText("Mouse ABC")).toBeInTheDocument();
    expect(screen.getByText("Headset Gamer XYZ")).toBeInTheDocument();
    // Tudo carregado: o botão sai e sobra o contador.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Carregar mais" })).not.toBeInTheDocument());
    expect(screen.getByText(/2 de 2 carregados/)).toBeInTheDocument();
  });

  it("erro do catálogo tem botão de tentar de novo", async () => {
    browseCatalog.mockRejectedValueOnce(new Error("Catálogo fora do ar"));
    render(<Harness />);

    expect(await screen.findByText("Catálogo fora do ar")).toBeInTheDocument();
    browseCatalog.mockResolvedValue({ items: [makeProduct()], total: 1, page: 1, pageSize: 24 });
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("Headset Gamer XYZ")).toBeInTheDocument();
  });

  it("lista vazia com filtro ligado oferece limpar os filtros", async () => {
    browseCatalog.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 24 });
    render(<Harness initialScraping={{
      auto: true, sources: ["Mercado Livre"], filters: { minDiscount: 70 },
    }} />);

    expect(await screen.findByText(/Nenhum produto do catálogo passa nesses filtros/)).toBeInTheDocument();
    // O outro "Limpar filtros" é o dos chips, em cima; aqui interessa o do vazio.
    const limpar = screen.getAllByRole("button", { name: "Limpar filtros" });
    fireEvent.click(limpar[limpar.length - 1]);
    await waitFor(() => {
      const last = browseCatalog.mock.calls[browseCatalog.mock.calls.length - 1][0];
      expect(last.minDiscount).toBe(0);
    });
  });
});

describe("ProductSearchTab — barra de salvar", () => {
  it("só aparece quando há alteração não salva", async () => {
    const { rerender } = render(<Harness />);
    await screen.findByText("Headset Gamer XYZ");
    expect(screen.queryByRole("button", { name: "Salvar configurações" })).not.toBeInTheDocument();

    const save = vi.fn();
    rerender(<Harness dirty save={save} />);
    fireEvent.click(await screen.findByRole("button", { name: "Salvar configurações" }));
    expect(save).toHaveBeenCalled();
    expect(screen.getByText(/alterações não salvas/)).toBeInTheDocument();
  });
});
