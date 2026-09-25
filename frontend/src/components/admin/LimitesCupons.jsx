// Os limites das duas etapas da colheita de cupons, uma peça por etapa.
//
// Moravam dentro de `AdminCupomML` num bloco só, embaixo dos três botões — e era
// exatamente essa pilha de quatorze campos sem dono que virou o "tá tudo meio
// confuso" da task 19. Agora cada etapa tem o seu card, e um card com os controles
// dos outros dois dentro não é card.
//
// Saem da página também porque a aba "Config" os importava de lá (`AdminCupomConfig`
// fazia `import { Config } from "./AdminCupomML"`): aba importando página é o tipo de
// laço que só se percebe quando quebra.
import { useState } from "react";
import { adminMlCuponsSaveConfig } from "../../data/api";
import { rotuloCategoria } from "../../data/cupomCategorias";
import { inputStyle, labelStyle, botaoSecundario, botaoLink } from "./cupomEstilos";

// As chaves de cada etapa. Uma lista só, ao lado dos campos que as desenham: duas
// listas discordando é como um campo passa a ser editável numa tela e não salvar em
// nenhuma.
const CHAVES_LISTA = ["maxPaginasLista", "limiteCupons", "carimbarCategorias", "maxPaginasPorCategoria", "categorias", "paginasDeListaEmParalelo"];
const CHAVES_PRODUTOS = ["maxProductsPerCoupon", "maxPaginasVitrine", "pausaEntreVitrinesMs", "vitrinesEmParalelo", "limiteCuponsProdutos", "tamanhoLoteProdutos", "activateCoupons", "maxActivationsPerRun"];

const linha = { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 };
const nota = { fontSize: 11, color: "var(--color-text-secondary)", marginTop: 8, lineHeight: 1.5 };

// O rascunho de UMA etapa.
//
// O padrão é o mesmo que o `Config` inteiro já usava — estado derivado
// (`edit || config`) em vez de efeito copiando prop pra estado, que é o que desfazia
// a edição sozinho a cada volta do poll de status.
//
// Um rascunho POR ETAPA, e não um só compartilhado, porque o salvar de cada card
// manda apenas as chaves dele: com rascunho único, salvar os limites da lista
// embarcaria junto o teto de aceites que alguém estava mexendo no card ao lado — e
// aceitar é escrita irreversível na conta do ML. Mandar um pedaço é seguro por
// desenho: o `writeConfig` (backend/coupons/sync.js) mescla sobre o que já está
// gravado e reclampa chave por chave. Se um dia alguém trocar essa mescla por
// sobrescrita, os três salvares passam a zerar a config uns dos outros calados.
function useRascunho(config, chaves, onSaved) {
  const [edit, setEdit] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const cfg = edit || config;
  const setCfg = (fn) => setEdit(typeof fn === "function" ? fn(cfg) : fn);

  const salvar = async () => {
    setSalvando(true);
    const parcial = Object.fromEntries(chaves.filter(k => cfg[k] !== undefined).map(k => [k, cfg[k]]));
    try { await adminMlCuponsSaveConfig(parcial); onSaved?.(); } catch { /* o erro aparece na próxima leitura */ }
    finally { setSalvando(false); }
  };

  return { cfg, setCfg, salvar, salvando };
}

// Um campo numérico da config. Existem quatorze deles — repetir o label + input +
// onChange quatorze vezes é onde um `min` errado passa despercebido.
//
// O `id`/`htmlFor` não é enfeite: sem ele, ninguém — nem leitor de tela, nem teste —
// consegue pedir o campo pelo nome que está escrito na tela.
function Numerico({ cfg, setCfg, chave, label, min, max, dica, largura = 120, desabilitado = false }) {
  const id = `cfg-${chave}`;
  return (
    <div style={{ opacity: desabilitado ? 0.45 : 1 }}>
      <label htmlFor={id} style={labelStyle} title={dica}>{label}</label>
      <input
        id={id}
        type="number" min={min} max={max} value={cfg[chave] ?? ""}
        disabled={desabilitado}
        onChange={e => setCfg(c => ({ ...c, [chave]: Number(e.target.value) }))}
        style={{ ...inputStyle, width: largura }}
      />
    </div>
  );
}

function Marcador({ cfg, setCfg, chave, label, desabilitado = false }) {
  return (
    <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, paddingBottom: 8, opacity: desabilitado ? 0.45 : 1 }}>
      <input
        type="checkbox"
        checked={cfg[chave] !== false}
        disabled={desabilitado}
        onChange={e => setCfg(c => ({ ...c, [chave]: e.target.checked }))}
      />
      {label}
    </label>
  );
}

// O rodapé de cada etapa: o salvar, com nome PRÓPRIO. Três botões escritos só
// "salvar" na mesma tela não dizem qual salva o quê — nem para quem lê, nem para
// quem procura um deles pelo nome.
function Salvar({ o_que, salvar, salvando, desabilitado }) {
  return (
    <div style={{ marginTop: 12 }}>
      <button onClick={salvar} disabled={salvando || desabilitado} style={botaoSecundario}>
        {salvando ? "salvando…" : `salvar os limites ${o_que}`}
      </button>
    </div>
  );
}

// O cabeçalho de uma peça solta, dentro do card da etapa. No `Config` inteiro quem
// separa as três é o subtítulo ("Etapa 1 — a lista"); aqui o card já tem título, e
// repeti-lo seria dizer a mesma coisa duas vezes de fio a pavio.
function Moldura({ titulo, children }) {
  return (
    <div style={{ marginTop: 14, borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 10 }}>
      {titulo && <div style={{ fontWeight: 500, fontSize: 12, marginBottom: 2 }}>{titulo}</div>}
      {children}
    </div>
  );
}

// ETAPA 1 — a lista.
//
// `semTeto` é a escolha "tudo o que o ML tiver" do card 1 (task 20): ela apaga os
// três tetos, porque nessa escolha eles não valem. Os valores salvos continuam à
// mostra de propósito — eles voltam a valer na outra opção, e um campo desabilitado
// mostrando o número guardado é a leitura honesta do que está configurado.
export function LimitesLista({ config, labels, onSaved, desabilitado = false, semTeto = false, comTitulo = false }) {
  const { cfg, setCfg, salvar, salvando } = useRascunho(config, CHAVES_LISTA, onSaved);
  if (!cfg) return null;

  // As categorias que dá pra escolher para o CARIMBO. Só as VERTICAIS: o
  // dicionário do ML mistura filtro com categoria — `price` ("Mais de R$100"),
  // `percentage`, `recommended` estão na mesma lista, e carimbar por eles poria no
  // cupom uma "categoria" que não existe. O sufixo é o que o próprio ML usa.
  const verticais = Object.keys(labels || {})
    .filter(k => /_vertical$/.test(k))
    .sort((a, b) => rotuloCategoria(a, labels).localeCompare(rotuloCategoria(b, labels), "pt-BR"));
  const escolhidas = Array.isArray(cfg.categorias) ? cfg.categorias : [];
  const alternar = (chave) => setCfg(c => {
    const atuais = Array.isArray(c.categorias) ? c.categorias : [];
    return { ...c, categorias: atuais.includes(chave) ? atuais.filter(k => k !== chave) : [...atuais, chave] };
  });

  return (
    <Moldura titulo={comTitulo ? "Etapa 1 — a lista" : "Limites desta etapa"}>
      {semTeto && (
        <div style={{ ...nota, marginTop: 0 }}>
          Os três tetos abaixo <b>não valem</b> na escolha “tudo o que o ML tiver” — eles voltam a
          valer em “até os limites abaixo”.
        </div>
      )}
      <div style={linha}>
        <Numerico cfg={cfg} setCfg={setCfg} chave="maxPaginasLista" label="Páginas da lista geral" min={1} max={200}
          desabilitado={desabilitado || semTeto}
          dica="A lista traz 30 cupons por página. 40 páginas = 1.200 cupons." />
        <Numerico cfg={cfg} setCfg={setCfg} chave="limiteCupons" label="Teto de cupons (0 = todos)" min={0} max={20000} largura={140}
          desabilitado={desabilitado || semTeto} />
        {/* Fora do `semTeto` de propósito: este campo não é um teto, é a
            velocidade — e é justamente no modo "tudo o que o ML tiver" que ele
            mais importa, porque é lá que a lista é longa. */}
        <Numerico cfg={cfg} setCfg={setCfg} chave="paginasDeListaEmParalelo" label="Páginas ao mesmo tempo" min={1} max={8} largura={140}
          desabilitado={desabilitado}
          dica="1 = como sempre foi. Mais abas é mais rápido e mais chance de o ML pedir verificação — e a verificação vale para a conta inteira, que é a mesma do Hub." />
        <Marcador cfg={cfg} setCfg={setCfg} chave="carimbarCategorias" label="carimbar a categoria (passada por vertical)"
          desabilitado={desabilitado} />
        <Numerico cfg={cfg} setCfg={setCfg} chave="maxPaginasPorCategoria" label="Páginas por categoria" min={1} max={200}
          desabilitado={desabilitado || semTeto}
          dica="Também 30 por página. A maior vertical da conta tem ~1.170 cupons: 40 páginas cobrem 1.200. Cupom além deste teto fica sem categoria." />
      </div>
      <div style={nota}>
        A coleta é a <b>lista geral</b> (<code>?all=true</code>), que traz todos os cupons da conta.
        As passadas por categoria vêm depois e servem só para <b>carimbar</b> a vertical em quem já
        entrou: a lista do ML não diz a que categoria cada cupom pertence — quem diz é o filtro que
        a gente pede na URL. Sem elas a coluna Categoria fica vazia. <b>Quais</b> categorias existem
        a rodada descobre sozinha, na primeira página: o ML manda a lista delas em toda página da
        lista de cupons, e é por isso que a caixa abaixo pode ficar em branco sem prejuízo.
        Cupom de <b>loja</b> não entra em vertical nenhuma no ML — a Categoria dele é “—” por
        natureza, e quem o identifica é a coluna Tipo. Ignorá-lo é uma escolha do card 1, fora
        destes limites.
      </div>

      {verticais.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
            <label style={labelStyle}>Categorias a carimbar</label>
            <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
              {escolhidas.length ? `${escolhidas.length} escolhida${escolhidas.length === 1 ? "" : "s"}` : "carimba todas"}
            </span>
            {escolhidas.length > 0 && (
              <button type="button" onClick={() => setCfg(c => ({ ...c, categorias: [] }))} style={botaoLink}>
                carimbar todas
              </button>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
            {verticais.map(chave => (
              <label key={chave} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={escolhidas.includes(chave)}
                  disabled={desabilitado}
                  onChange={() => alternar(chave)}
                />
                {rotuloCategoria(chave, labels)}
              </label>
            ))}
          </div>
        </div>
      )}

      <Salvar o_que="da lista" salvar={salvar} salvando={salvando} desabilitado={desabilitado} />
    </Moldura>
  );
}

// ETAPA 2 — os produtos.
export function LimitesProdutos({ config, onSaved, desabilitado = false, comTitulo = false }) {
  const { cfg, setCfg, salvar, salvando } = useRascunho(config, CHAVES_PRODUTOS, onSaved);
  if (!cfg) return null;

  return (
    <Moldura titulo={comTitulo ? "Etapa 2 — os produtos" : "Limites desta etapa"}>
      <div style={linha}>
        <Numerico cfg={cfg} setCfg={setCfg} chave="maxProductsPerCoupon" label="Produtos por cupom" min={10} max={500} desabilitado={desabilitado} />
        <Numerico cfg={cfg} setCfg={setCfg} chave="maxPaginasVitrine" label="Páginas da vitrine" min={1} max={20} desabilitado={desabilitado}
          dica="A vitrine anda de 48 em 48 produtos. 11 páginas = até 528, o suficiente pro teto de 500." />
        <Numerico cfg={cfg} setCfg={setCfg} chave="pausaEntreVitrinesMs" label="Pausa entre vitrines (ms)" min={500} max={30000} largura={140} desabilitado={desabilitado} />
        <Numerico cfg={cfg} setCfg={setCfg} chave="vitrinesEmParalelo" label="Vitrines em paralelo" min={1} max={4} desabilitado={desabilitado}
          dica="Quantas vitrines abrem ao mesmo tempo (1 a 4). Mais abas é mais rápido, e também mais chance de o ML pedir verificação: o primeiro pedido para todas." />
        <Numerico cfg={cfg} setCfg={setCfg} chave="limiteCuponsProdutos" label="Cupons por rodada" min={0} max={2000} desabilitado={desabilitado}
          dica="Quantos cupons esta etapa busca por rodada. 0 = todos os que faltam (até 500 por rodada). Os que já têm vitrine vão primeiro." />
        <Numerico cfg={cfg} setCfg={setCfg} chave="tamanhoLoteProdutos" label="Cupons por lote" min={1} max={200} desabilitado={desabilitado}
          dica="Cada cupom é gravado no banco assim que sua vitrine é colhida. O lote é a unidade de trabalho: ativa este tanto de cupons, colhe e carimba o catálogo antes de passar aos próximos." />
        <Marcador cfg={cfg} setCfg={setCfg} chave="activateCoupons" label="aceitar os cupons automaticamente (“Eu quero”)" desabilitado={desabilitado} />
        <Numerico cfg={cfg} setCfg={setCfg} chave="maxActivationsPerRun" label="Aceites por rodada" min={0} max={500} desabilitado={desabilitado}
          dica="0 = sem teto (aceita todos). Para não aceitar nenhum, desmarque a caixa acima." />
      </div>
      <div style={nota}>
        <b>Aceitar é ESCRITA na sua conta do Mercado Livre</b> — é o mesmo “Eu quero” que você
        clicaria à mão, e não há como desfazer por aqui. É também a única forma de o cupom ter
        vitrine: sem aceitar, o ML não diz quais produtos ele cobre. A conta é a mesma do Hub de
        Afiliados, então a etapa 2 vai com pausa entre as abas e para no primeiro pedido de
        verificação — mas <b>sem teto de aceites ela clica em todos de uma vez</b>, que é o padrão
        que mais acorda o anti-robô. O mesmo vale para as <b>vitrines em paralelo</b>: cada aba a mais
        é mais uma batendo no ML com a mesma conta. Enquanto um lote colhe, o próximo já vai sendo
        aceito numa aba à parte. Se o teto de produtos cortar a vitrine no meio, ela entra
        marcada como <b>parcial</b> — prévia, não lista fechada.
      </div>
      <Salvar o_que="dos produtos" salvar={salvar} salvando={salvando} desabilitado={desabilitado} />
    </Moldura>
  );
}

// As duas de uma vez, para a aba "Config" — lá elas moram num card só, e aí os
// subtítulos por etapa voltam a fazer falta.
export function Config({ config, labels, onSaved }) {
  if (!config) return null;
  return (
    <div style={{ marginTop: 16, borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 12 }}>
      <div style={{ fontWeight: 500, marginBottom: 2 }}>Limites</div>
      <div style={nota}>
        Tudo o que as duas etapas fazem cabe aqui, e cada uma tem o seu <b>salvar</b>. Cada página
        aberta é uma visita ao ML com a sua conta — a mesma do Hub de Afiliados —, então subir muito
        estes números aumenta a chance de o ML pedir verificação.
      </div>
      <LimitesLista config={config} labels={labels} onSaved={onSaved} comTitulo />
      <LimitesProdutos config={config} onSaved={onSaved} comTitulo />
    </div>
  );
}
