import { useState, useEffect } from "react";
import { PRIMARY, formatDateBR, formatDateTimeBR, formatTimeBR } from "../data/constants";
import { getMLDesempenho, getShopeeDesempenho, errText } from "../data/api";
import AlertBanner from "../components/ui/AlertBanner";
import Tabs from "../components/ui/Tabs";
import { Card, Linha, Chip } from "../components/desempenho/comum";
import DesempenhoML from "../components/desempenho/DesempenhoML";
import DesempenhoShopee from "../components/desempenho/DesempenhoShopee";
import { PERIODOS, PERIODO_PADRAO, periodo } from "../data/desempenho";

// Cada loja: de onde vêm os números e como a tela fala dela. `kindsDeConfig` são
// os erros que se resolvem na aba de afiliado da loja (credencial ausente,
// vencida ou recusada): a tela aponta pra lá em vez de oferecer "tentar de
// novo", que não adiantaria.
const LOJAS = {
  ml: {
    label: "Mercado Livre",
    buscar: getMLDesempenho,
    buscando: "Buscando no Mercado Livre…",
    falhou: "Não foi possível buscar o desempenho no Mercado Livre.",
    kindsDeConfig: ["afiliado-ausente", "login-wall"],
    abrir: "Abrir aba Mercado Livre",
    Corpo: DesempenhoML,
  },
  shopee: {
    label: "Shopee",
    buscar: getShopeeDesempenho,
    buscando: "Buscando na Shopee…",
    falhou: "Não foi possível buscar o desempenho na Shopee.",
    kindsDeConfig: ["afiliado-ausente", "credencial-recusada"],
    abrir: "Abrir aba Shopee",
    Corpo: DesempenhoShopee,
  },
};

// `lojas` = as que o usuário pode ver (o App tira as trancadas pelo admin).
export default function PageDesempenho({ lojas = ["ml", "shopee"], lojaInicial, onGoToML, onGoToShopee }) {
  const disponiveis = lojas.filter(id => LOJAS[id]);
  // Cada pedido ao backend é uma `consulta` numerada; a resposta guarda o número
  // (e a loja) da consulta que a gerou. Assim "carregando" é só "a resposta é de
  // uma consulta velha", e trocar de período ou de loja no meio de uma busca
  // nunca deixa a resposta atrasada sobrescrever a nova.
  const [consulta, setConsulta] = useState(() => ({
    loja: disponiveis.includes(lojaInicial) ? lojaInicial : disponiveis[0],
    periodoId: PERIODO_PADRAO,
    refresh: false,
    n: 0,
  }));
  const [resposta, setResposta] = useState(null);   // { n, loja, dados, erro: { text, kind } }

  useEffect(() => {
    const cfg = LOJAS[consulta.loja];
    if (!cfg) return undefined;
    let viva = true;
    const { from, to } = periodo(consulta.periodoId);
    cfg.buscar(from, to, { refresh: consulta.refresh })
      .then(dados => { if (viva) setResposta({ n: consulta.n, loja: consulta.loja, dados, erro: null }); })
      .catch(err => {
        if (viva) setResposta({ n: consulta.n, loja: consulta.loja, dados: null, erro: { text: errText(err, cfg.falhou), kind: err?.body?.kind || null } });
      });
    return () => { viva = false; };
  }, [consulta]);

  const cfg = LOJAS[consulta.loja];
  if (!cfg) return null;

  const nova = (mudanca) => setConsulta(c => ({ ...c, refresh: false, ...mudanca, n: c.n + 1 }));
  const carregando = resposta?.n !== consulta.n;
  // Enquanto o período novo não chega, a tela segue mostrando o anterior (com as
  // datas dele no cabeçalho), em vez de piscar vazia — mas só se for da mesma
  // loja: o formato dos números muda de uma loja pra outra.
  const dados = resposta?.loja === consulta.loja ? resposta.dados : null;
  const erro = carregando ? null : resposta?.erro || null;
  const irParaAba = { ml: onGoToML, shopee: onGoToShopee }[consulta.loja];
  const Corpo = cfg.Corpo;

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 500, margin: "0 0 6px" }}>Desempenho</h2>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>
        Pedidos e ganhos dos seus links de afiliado, direto de cada loja.
      </div>

      <Tabs
        tabs={disponiveis.map(id => ({ id, label: LOJAS[id].label }))}
        active={consulta.loja}
        onChange={(id) => { if (id !== consulta.loja) nova({ loja: id }); }}
      />

      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <Linha>
            {PERIODOS.map(p => (
              <Chip key={p.id} ativo={p.id === consulta.periodoId} onClick={() => nova({ periodoId: p.id })}>{p.label}</Chip>
            ))}
          </Linha>
          <button
            onClick={() => nova({ refresh: true })}
            disabled={carregando}
            style={{ background: "transparent", border: "none", padding: 0, color: PRIMARY, fontSize: 12, cursor: carregando ? "default" : "pointer", fontFamily: "inherit", opacity: carregando ? 0.5 : 1 }}
          >
            {carregando ? "Buscando…" : "↻ Atualizar"}
          </button>
        </div>
        {dados && (
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 10, lineHeight: 1.6 }}>
            {formatDateBR(`${dados.from}T12:00:00Z`)} a {formatDateBR(`${dados.to}T12:00:00Z`)}
            {dados.summary?.lastUpdate && <> · dados do ML de {formatDateTimeBR(dados.summary.lastUpdate)}</>}
            {dados.fetchedAt && <> · consultado às {formatTimeBR(dados.fetchedAt)}</>}
            {dados.requestedFrom && (
              <div>A Shopee só guarda os últimos 3 meses — o período começa em {formatDateBR(`${dados.from}T12:00:00Z`)}.</div>
            )}
          </div>
        )}
      </Card>

      {erro && (cfg.kindsDeConfig.includes(erro.kind)
        ? <AlertBanner tone="warn" message={erro.text} actions={irParaAba ? [{ label: cfg.abrir, onClick: irParaAba }] : undefined} />
        : <AlertBanner tone="error" message={erro.text} onRetry={() => nova({})} />)}

      {!dados && carregando && (
        <Card style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{cfg.buscando}</Card>
      )}

      {dados?.summary && <Corpo dados={dados} />}
    </div>
  );
}
