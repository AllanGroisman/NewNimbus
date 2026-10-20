import { useState, useEffect } from "react";
import { PRIMARY, formatDateBR, formatDateTimeBR, formatTimeBR } from "../data/constants";
import { getMLDesempenho, getShopeeDesempenho, errText } from "../data/api";
import AlertBanner from "../components/ui/AlertBanner";
import Tabs from "../components/ui/Tabs";
import SeletorPeriodo from "../components/ui/SeletorPeriodo";
import { Card } from "../components/desempenho/comum";
import DesempenhoML from "../components/desempenho/DesempenhoML";
import DesempenhoShopee from "../components/desempenho/DesempenhoShopee";
import {
  hojeBR, somaDias, resolvePeriodo, periodoAnterior, ajustaAoLimite, comoPreset, inicioShopee, rotuloPeriodo,
} from "../data/periodos";

const PERIODO_PADRAO = { id: "30d" };

// Cada loja: de onde vêm os números, como a tela fala dela e o período que ela
// responde. `kindsDeConfig` são os erros que se resolvem na aba de afiliado da
// loja (credencial ausente, vencida ou recusada): a tela aponta pra lá em vez de
// oferecer "tentar de novo", que não adiantaria.
const LOJAS = {
  ml: {
    label: "Mercado Livre",
    buscar: getMLDesempenho,
    buscando: "Buscando no Mercado Livre…",
    falhou: "Não foi possível buscar o desempenho no Mercado Livre.",
    kindsDeConfig: ["afiliado-ausente", "login-wall"],
    abrir: "Abrir aba Mercado Livre",
    Corpo: DesempenhoML,
    presets: ["ontem", "7d", "30d", "mes", "mes-passado"],
    // O painel do ML só fecha o dia seguinte e recusa mais de 6 meses.
    limites: (hoje) => ({ max: somaDias(hoje, -1), maxDias: 180 }),
  },
  shopee: {
    label: "Shopee",
    buscar: getShopeeDesempenho,
    buscando: "Buscando na Shopee…",
    falhou: "Não foi possível buscar o desempenho na Shopee.",
    kindsDeConfig: ["afiliado-ausente", "credencial-recusada"],
    abrir: "Abrir aba Shopee",
    Corpo: DesempenhoShopee,
    presets: ["hoje", "ontem", "7d", "30d", "mes", "mes-passado"],
    // A Shopee já tem as vendas de hoje, mas só guarda os últimos 3 meses.
    limites: (hoje) => ({ min: inicioShopee(hoje), max: hoje }),
  },
};

// `lojas` = as que o usuário pode ver (o App tira as trancadas pelo admin).
// `campanhas` (os grupos do App) dão nome e link às linhas "Por campanha" e às
// etiquetas; `mlTags`/`mlDefaultTag` dizem qual etiqueta cada campanha usa.
export default function PageDesempenho({
  lojas = ["ml", "shopee"], lojaInicial, onGoToML, onGoToShopee,
  campanhas = [], onOpenCampanha, mlTags = [], mlDefaultTag = null,
}) {
  const disponiveis = lojas.filter(id => LOJAS[id]);
  // Cada pedido ao backend é uma `consulta` numerada; a resposta guarda o número
  // (e a loja) da consulta que a gerou. Assim "carregando" é só "a resposta é de
  // uma consulta velha", e trocar de período ou de loja no meio de uma busca
  // nunca deixa a resposta atrasada sobrescrever a nova.
  const [consulta, setConsulta] = useState(() => {
    const loja = disponiveis.includes(lojaInicial) ? lojaInicial : disponiveis[0];
    const cfg = LOJAS[loja];
    return {
      loja,
      periodo: cfg ? ajustaAoLimite(PERIODO_PADRAO, { presets: cfg.presets, ...cfg.limites(hojeBR()) }) : PERIODO_PADRAO,
      refresh: false,
      n: 0,
    };
  });
  const [resposta, setResposta] = useState(null);   // { n, loja, refresh, dados, erro: { text, kind } }

  useEffect(() => {
    const cfg = LOJAS[consulta.loja];
    if (!cfg) return undefined;
    let viva = true;
    const intervalo = resolvePeriodo(consulta.periodo);
    // O anterior é o que a seta ‹ abriria: o backend busca os dois pelo mesmo
    // cache, então voltar um período depois já sai pronto.
    const ant = periodoAnterior({ ...consulta.periodo, ...intervalo });
    cfg.buscar(intervalo.from, intervalo.to, { refresh: consulta.refresh, antFrom: ant?.from, antTo: ant?.to })
      .then(dados => { if (viva) setResposta({ n: consulta.n, loja: consulta.loja, refresh: consulta.refresh, dados, erro: null }); })
      .catch(err => {
        if (viva) setResposta({ n: consulta.n, loja: consulta.loja, dados: null, erro: { text: errText(err, cfg.falhou), kind: err?.body?.kind || null } });
      });
    return () => { viva = false; };
  }, [consulta]);

  const cfg = LOJAS[consulta.loja];
  if (!cfg) return null;

  const hoje = hojeBR();
  const limites = cfg.limites(hoje);
  const nova = (mudanca) => setConsulta(c => ({ ...c, refresh: false, ...mudanca, n: c.n + 1 }));
  const trocaLoja = (id) => {
    if (id === consulta.loja) return;
    const destino = LOJAS[id];
    nova({ loja: id, periodo: ajustaAoLimite(consulta.periodo, { presets: destino.presets, ...destino.limites(hoje) }) });
  };
  const verDia = (dia) => nova({ periodo: comoPreset({ from: dia, to: dia }, cfg.presets, {}) });
  const carregando = resposta?.n !== consulta.n;
  // Enquanto o período novo não chega, a tela segue mostrando o anterior, em vez
  // de piscar vazia — mas só se for da mesma loja: o formato dos números muda de
  // uma loja pra outra.
  const dados = resposta?.loja === consulta.loja ? resposta.dados : null;
  const erro = carregando ? null : resposta?.erro || null;
  const irParaAba = { ml: onGoToML, shopee: onGoToShopee }[consulta.loja];
  const Corpo = cfg.Corpo;
  // A Shopee não tem o período anterior quando ele passa dos 3 meses dela.
  const intervalo = resolvePeriodo(consulta.periodo);
  const antPedido = periodoAnterior({ ...consulta.periodo, ...intervalo });
  const semAnteriorNaShopee = consulta.loja === "shopee" && dados && !dados.anterior && antPedido && antPedido.from < limites.min;

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 500, margin: "0 0 6px" }}>Desempenho</h2>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>
        Pedidos e ganhos dos seus links de afiliado, direto de cada loja.
      </div>

      <Tabs
        tabs={disponiveis.map(id => ({ id, label: LOJAS[id].label }))}
        active={consulta.loja}
        onChange={trocaLoja}
      />

      <Card>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SeletorPeriodo valor={consulta.periodo} onChange={(periodo) => nova({ periodo })} presets={cfg.presets} {...limites} />
          </div>
          <button
            onClick={() => nova({ refresh: true })}
            disabled={carregando}
            style={{ background: "transparent", border: "none", padding: "8px 4px", margin: "-2px -4px 0", color: PRIMARY, fontSize: 12, cursor: carregando ? "default" : "pointer", fontFamily: "inherit", opacity: carregando ? 0.5 : 1, whiteSpace: "nowrap", flexShrink: 0 }}
          >
            {carregando ? "Buscando…" : "↻ Atualizar"}
          </button>
        </div>
        {dados && (
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 10, lineHeight: 1.6 }}>
            {dados.anterior && <>Comparando com {rotuloPeriodo(dados.anterior)}</>}
            {dados.summary?.lastUpdate && <>{dados.anterior ? " · " : ""}dados do ML de {formatDateTimeBR(dados.summary.lastUpdate)}</>}
            {dados.fetchedAt && <>{dados.anterior || dados.summary?.lastUpdate ? " · " : ""}consultado às {formatTimeBR(dados.fetchedAt)}</>}
            {dados.requestedFrom && (
              <div>A Shopee só guarda os últimos 3 meses — o período começa em {formatDateBR(`${dados.from}T12:00:00Z`)}.</div>
            )}
            {semAnteriorNaShopee && <div>Sem comparação: o período anterior passa dos 3 meses que a Shopee guarda.</div>}
          </div>
        )}
      </Card>

      {erro && (cfg.kindsDeConfig.includes(erro.kind)
        ? <AlertBanner tone="warn" message={erro.text} actions={irParaAba ? [{ label: cfg.abrir, onClick: irParaAba }] : undefined} />
        : <AlertBanner tone="error" message={erro.text} onRetry={() => nova({})} />)}

      {!dados && carregando && (
        <Card style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{cfg.buscando}</Card>
      )}

      {dados?.summary && (
        <div style={{ opacity: carregando ? 0.6 : 1 }}>
          <Corpo
            dados={dados}
            onDia={verDia}
            campanhas={campanhas}
            onOpenCampanha={onOpenCampanha}
            mlTags={mlTags}
            mlDefaultTag={mlDefaultTag}
            versao={resposta.n}
            atualizado={!!resposta.refresh}
          />
        </div>
      )}
    </div>
  );
}
