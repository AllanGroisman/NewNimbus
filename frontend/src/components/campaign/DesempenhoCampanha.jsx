import { useState, useEffect } from "react";
import { PRIMARY, formatDateBR, groupUsesML, groupUsesShopee, storeLockMessage } from "../../data/constants";
import { getCampanhaDesempenho, getShopeeDesempenho, getMLDesempenho, errText } from "../../data/api";
import { formatBRL, formatInt, etiquetaEfetiva } from "../../data/desempenho";
import { formatSaldo } from "../../data/grupos";
import { hojeBR, somaDias, resolvePeriodo, periodoAnterior, comoPreset, variacao } from "../../data/periodos";
import StatCard from "../ui/StatCard";
import SeletorPeriodo from "../ui/SeletorPeriodo";
import { Card, Linha, PorDia } from "../desempenho/comum";
import { ListaVendas } from "../desempenho/DesempenhoShopee";

// Mini Desempenho da visão geral de uma campanha: o que ela enviou, como andam
// os membros dos grupos de destino e o que vendeu, num período escolhido.
//
// Três buscas independentes — cada uma carrega e falha sozinha:
//   - sistema (/api/state/groups/:id/desempenho): ofertas e membros por dia;
//   - Shopee: as vendas marcadas com esta campanha (sub_id do link);
//   - ML: a linha da etiqueta da campanha — o ML separa por etiqueta, não por
//     campanha, e não tem o detalhe por dia dela.
// As lojas usam o mesmo cache do Desempenho: abrir uma depois da outra não
// pergunta de novo à loja.

const PRESETS = ["hoje", "ontem", "7d", "30d"];
const MAX_DIAS = 180;
const KINDS_DE_CONFIG = ["afiliado-ausente", "login-wall", "credencial-recusada"];
const secundario = { fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 };
const dataCurta = (dia) => formatDateBR(`${dia}T12:00:00Z`);

// Busca que refaz quando `chave` muda e guarda de qual chave veio a resposta:
// resposta atrasada de um período antigo nunca aparece como a do atual, e a do
// período anterior continua na tela (apagada) enquanto a nova não chega.
// `buscar` null = seção desligada. O poll de 3 s recria o objeto da campanha a
// cada tick, por isso a chave é uma string de primitivos, não o objeto.
function useBusca(chave, buscar) {
  const [resposta, setResposta] = useState(null);   // { chave, dados, erro }
  useEffect(() => {
    if (!buscar) return undefined;
    let viva = true;
    buscar()
      .then(dados => { if (viva) setResposta({ chave, dados, erro: null }); })
      .catch(erro => { if (viva) setResposta({ chave, dados: null, erro }); });
    return () => { viva = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave]);
  if (!buscar) return { ligada: false, carregando: false, dados: null, erro: null, ultimoErro: null };
  const atual = resposta?.chave === chave;
  return {
    ligada: true,
    carregando: !atual,
    dados: resposta?.dados || null,
    erro: atual ? resposta.erro : null,
    // O erro da última resposta, mesmo de uma chave antiga (a tela não pisca
    // enquanto tenta de novo).
    ultimoErro: resposta?.erro || null,
  };
}

// Campanha recém-criada: o App salva com atraso, e o primeiro pedido pode chegar
// antes de ela existir no banco (404). Tenta de novo a cada 3 s, por até um
// minuto, em vez de ficar no aviso até alguém trocar o período.
const REPETE_404_MS = 3000;
const REPETE_404_MAX = 20;

// Erro de uma loja numa linha discreta: config resolvida na aba da loja vira
// botão pra lá; o resto, "Tentar de novo".
function ErroDaLoja({ erro, loja, falhou, onAbrir, onTentar }) {
  const config = KINDS_DE_CONFIG.includes(erro?.body?.kind);
  const texto = errText(erro, falhou);
  return (
    <div style={{ ...secundario, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
      <span>{texto}</span>
      <button
        type="button"
        onClick={config ? onAbrir : onTentar}
        style={{ background: "transparent", border: "none", padding: 0, color: PRIMARY, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}
      >
        {config ? `Abrir aba ${loja}` : "Tentar de novo"}
      </button>
    </div>
  );
}

export default function DesempenhoCampanha({ group, storeLocks, affiliateStatus = {}, campanhas = [], onGoToAffiliate }) {
  const [periodo, setPeriodo] = useState({ id: "7d" });
  const [rodada, setRodada] = useState(0);           // "Atualizar" e "Tentar de novo"
  const [refresh, setRefresh] = useState(false);
  const [reSistema, setReSistema] = useState(0);     // as novas tentativas do 404

  const hoje = hojeBR();
  const ontem = somaDias(hoje, -1);
  const intervalo = resolvePeriodo(periodo);
  const { from, to } = intervalo;
  const ant = periodoAnterior({ ...periodo, ...intervalo });
  const umDia = from === to;

  // Lojas: só as que a campanha usa (pelo que está SALVO, não pelo rascunho da
  // aba Gerenciar) e que o admin não trancou.
  const scraping = group.scraping || {};
  const usaShopee = groupUsesShopee(group) && !storeLockMessage(storeLocks, "shopee");
  const usaML = groupUsesML(group) && !storeLockMessage(storeLocks, "ml");
  const opcoesTag = { mlTags: affiliateStatus.mlTags || [], mlDefaultTag: affiliateStatus.mlDefaultTag || null };
  const etiqueta = usaML ? etiquetaEfetiva(scraping, opcoesTag) : null;
  // O ML só fecha o dia seguinte: o período dele termina ontem, e "Hoje" não tem ML.
  const mlTo = to > ontem ? ontem : to;
  const mlTemDia = from <= mlTo;
  const mlAnt = mlTemDia ? periodoAnterior({ from, to: mlTo }) : null;

  const base = `${group.id}|${from}|${to}|${rodada}`;
  const sistema = useBusca(`${base}|${reSistema}`, () => getCampanhaDesempenho(group.id, { from, to, antFrom: ant?.from, antTo: ant?.to }));
  const shopee = useBusca(`${base}|${usaShopee}`, usaShopee
    ? () => getShopeeDesempenho(from, to, { campanha: group.id, antFrom: ant?.from, antTo: ant?.to, refresh })
    : null);
  const ml = useBusca(`${base}|${usaML}|${mlTo}`, usaML && mlTemDia
    ? () => getMLDesempenho(from, mlTo, { antFrom: mlAnt?.from, antTo: mlAnt?.to, refresh })
    : null);

  // `sistema.erro` é um objeto novo a cada resposta: cada 404 arma a próxima tentativa.
  useEffect(() => {
    if (sistema.erro?.status !== 404 || reSistema >= REPETE_404_MAX) return undefined;
    const t = setTimeout(() => setReSistema(n => n + 1), REPETE_404_MS);
    return () => clearTimeout(t);
  }, [sistema.erro, reSistema]);

  const muda = (p) => { setRefresh(false); setPeriodo(p); };
  const atualizar = () => { setRefresh(true); setRodada(r => r + 1); };
  const tentar = () => { setRefresh(false); setRodada(r => r + 1); };
  const verDia = (dia) => muda(comoPreset({ from: dia, to: dia }, PRESETS, {}));
  const carregando = sistema.carregando || shopee.carregando || ml.carregando;

  // ── Números ──────────────────────────────────────────────────────────
  const s = sistema.dados;
  const sAnt = s?.anterior || null;
  const sp = shopee.dados;
  const spAnt = sp?.anterior?.summary || null;
  const linhaML = ml.dados?.tags?.find(t => t.tag === etiqueta) || null;
  const linhaMLAnt = ml.dados?.anterior?.tags ? (ml.dados.anterior.tags.find(t => t.tag === etiqueta) || { clicks: 0, units: 0, earnings: 0 }) : null;
  const naoSalva = !sistema.dados && (sistema.erro || sistema.ultimoErro)?.status === 404;
  const outrasNaEtiqueta = etiqueta
    ? campanhas.filter(c => String(c.id) !== String(group.id) && groupUsesML(c) && etiquetaEfetiva(c.scraping, opcoesTag) === etiqueta)
    : [];
  const valor = (dados, texto) => (dados ? texto : "…");

  // Por dia: o do sistema, com os pedidos e a comissão da Shopee do mesmo dia.
  const vendasDoDia = new Map((sp?.days || []).map(d => [d.date, d]));
  const dias = (s?.porDia || []).map(d => ({
    ...d,
    pedidosShopee: vendasDoDia.get(d.date)?.orders || 0,
    comissaoShopee: vendasDoDia.get(d.date)?.commission || 0,
  }));
  const series = [
    { id: "produtos", label: "Ofertas", formata: formatInt },
    { id: "saldo", label: "Entradas e saídas", tipo: "saldo" },
    ...(usaShopee && sp ? [
      { id: "pedidosShopee", label: "Pedidos Shopee", formata: formatInt },
      { id: "comissaoShopee", label: "Comissão Shopee", formata: formatBRL },
    ] : []),
  ];

  return (
    <div>
      <Card>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SeletorPeriodo valor={periodo} onChange={muda} presets={PRESETS} max={hoje} maxDias={MAX_DIAS} />
          </div>
          <button
            type="button"
            onClick={atualizar}
            disabled={carregando}
            style={{ background: "transparent", border: "none", padding: "8px 4px", margin: "-2px -4px 0", color: PRIMARY, fontSize: 12, cursor: carregando ? "default" : "pointer", fontFamily: "inherit", opacity: carregando ? 0.5 : 1, whiteSpace: "nowrap", flexShrink: 0 }}
          >
            {carregando ? "Carregando…" : "↻ Atualizar"}
          </button>
        </div>
      </Card>

      {naoSalva ? (
        <Card style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Os números aparecem assim que a campanha for salva.</Card>
      ) : (
        <div style={{ opacity: carregando ? 0.6 : 1 }}>
          {sistema.erro && <ErroDaLoja erro={sistema.erro} falhou="Não foi possível carregar os envios da campanha." onTentar={tentar} />}

          <Linha style={{ marginBottom: 8 }}>
            <StatCard
              label="Ofertas enviadas"
              value={valor(s, formatInt(s?.envios.produtos))}
              sub={s ? `em ${formatInt(s.envios.mensagens)} ${s.envios.mensagens === 1 ? "mensagem" : "mensagens"}` : undefined}
              variacao={s && sAnt?.envios ? variacao(s.envios.produtos, sAnt.envios.produtos) : null}
            />
            <StatCard
              label="Membros"
              value={valor(s, s?.membros.grupos ? formatInt(s.membros.membros) : "—")}
              sub={s ? (s.membros.grupos ? `saldo ${formatSaldo(s.membros.saldo)} no período` : "sem grupo de destino") : undefined}
            />
            <StatCard
              label="Entradas"
              value={valor(s, formatInt(s?.membros.entradas))}
              variacao={s && sAnt?.membros ? variacao(s.membros.entradas, sAnt.membros.entradas) : null}
            />
            <StatCard
              label="Saídas"
              value={valor(s, formatInt(s?.membros.saidas))}
              variacao={s && sAnt?.membros ? variacao(s.membros.saidas, sAnt.membros.saidas) : null}
              menosEhMelhor
            />
          </Linha>

          {(usaShopee || usaML) && (
            <Linha style={{ marginBottom: 8 }}>
              {usaShopee && !shopee.erro && (
                <>
                  <StatCard
                    label="Comissão Shopee"
                    value={valor(sp, formatBRL(sp?.summary.commission.total))}
                    color="var(--success-text)"
                    sub={sp ? `${formatBRL(sp.summary.sales)} em vendas` : undefined}
                    variacao={sp && spAnt ? variacao(sp.summary.commission.total, spAnt.commission.total) : null}
                  />
                  <StatCard
                    label="Pedidos Shopee"
                    value={valor(sp, formatInt(sp?.summary.orders))}
                    variacao={sp && spAnt ? variacao(sp.summary.orders, spAnt.orders) : null}
                  />
                </>
              )}
              {usaML && mlTemDia && etiqueta && !ml.erro && (
                <>
                  <StatCard
                    label="Ganho ML"
                    value={valor(ml.dados, formatBRL(linhaML?.earnings))}
                    color="var(--success-text)"
                    sub={ml.dados ? `${formatInt(linhaML?.units)} ${linhaML?.units === 1 ? "produto" : "produtos"}` : undefined}
                    variacao={linhaML && linhaMLAnt ? variacao(linhaML.earnings, linhaMLAnt.earnings) : null}
                  />
                  <StatCard
                    label="Cliques ML"
                    value={valor(ml.dados, formatInt(linhaML?.clicks))}
                    variacao={linhaML && linhaMLAnt ? variacao(linhaML.clicks, linhaMLAnt.clicks) : null}
                  />
                </>
              )}
            </Linha>
          )}

          <div style={{ marginBottom: 12, display: "flex", flexDirection: "column", gap: 2 }}>
            {usaShopee && shopee.erro && (
              <ErroDaLoja erro={shopee.erro} loja="Shopee" falhou="Não foi possível buscar as vendas da Shopee." onAbrir={() => onGoToAffiliate?.("shopee")} onTentar={tentar} />
            )}
            {usaML && ml.erro && (
              <ErroDaLoja erro={ml.erro} loja="Mercado Livre" falhou="Não foi possível buscar o desempenho no Mercado Livre." onAbrir={() => onGoToAffiliate?.("ml")} onTentar={tentar} />
            )}
            {usaML && !mlTemDia && <div style={secundario}>O Mercado Livre só mostra os números de hoje amanhã.</div>}
            {usaML && mlTemDia && mlTo < to && <div style={secundario}>Mercado Livre: até ontem — o ML só fecha o dia seguinte.</div>}
            {usaML && mlTemDia && !etiqueta && !ml.erro && <div style={secundario}>Sem etiqueta do Mercado Livre — teste o cookie na aba Mercado Livre pra buscar as etiquetas.</div>}
            {usaML && mlTemDia && etiqueta && !ml.erro && (
              <div style={secundario}>
                O ML separa o ganho por etiqueta, não por campanha: estes são os da etiqueta <strong>{etiqueta}</strong>
                {outrasNaEtiqueta.length > 0 && <>, também usada por {outrasNaEtiqueta.map(c => c.name).join(", ")}</>}.
              </div>
            )}
            {sp?.requestedFrom && <div style={secundario}>A Shopee só guarda os últimos 3 meses — as vendas começam em {dataCurta(sp.from)}.</div>}
            {s && s.envios.produtos > 0 && s.enviosDesde && from < s.enviosDesde && (
              <div style={secundario}>Envios registrados desde {dataCurta(s.enviosDesde)}.</div>
            )}
            {s && s.membros.grupos > 0 && (!s.coletandoDesde || from < s.coletandoDesde) && (
              <div style={secundario}>
                {s.coletandoDesde
                  ? <>Entradas e saídas registradas desde {dataCurta(s.coletandoDesde)}.</>
                  : <>As entradas e saídas começam a ser registradas quando o WhatsApp do grupo estiver conectado.</>}
              </div>
            )}
          </div>

          {!umDia && s && <PorDia dias={dias} series={series} onDia={verDia} />}

          {usaShopee && sp && (
            <Card>
              <div style={{ fontWeight: 500, marginBottom: 6 }}>Vendas da Shopee nesta campanha</div>
              <ListaVendas key={`${sp.from}|${sp.to}`} vendas={sp.sales || []} total={sp.totalSales || 0} />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
