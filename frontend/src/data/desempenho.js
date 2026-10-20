// Contas puras da tela Desempenho (pages/Desempenho.jsx): períodos e formatos.
// Moram fora do componente pra serem testáveis sem renderizar nada. As contas
// de período em si estão em ./periodos (são as mesmas da campanha e da aba Grupos).
import { resolvePeriodo } from "./periodos";

export { hojeBR, somaDias } from "./periodos";

// Preset → { from, to }, datas inclusivas, terminando ONTEM (o painel do ML só
// fecha o dia seguinte). Id desconhecido cai nos 30 dias.
export function periodo(id, now = new Date()) {
  const r = resolvePeriodo({ id }, { now }) || resolvePeriodo({ id: "30d" }, { now });
  return { from: r.from, to: r.to };
}

export function formatBRL(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatInt(v) {
  return (Number(v) || 0).toLocaleString("pt-BR");
}

// "12%" / "12,5%".
export function pct(v) {
  return `${Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

// Pedidos ÷ cliques, em %. "—" sem clique (não é 0%, é "não dá pra saber").
export function conversao(orders, clicks) {
  if (!clicks) return "—";
  return `${((orders / clicks) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

// "28/09" a partir de "2026-09-28".
export function diaCurto(dia) {
  const [, m, d] = String(dia).split("-");
  return d && m ? `${d}/${m}` : String(dia);
}

// Com qual etiqueta do ML os links da campanha saem: a escolhida
// (`scraping.mlTag`) se ela ainda é da conta, senão a padrão. Espelho do
// affiliate.etiquetaMLEfetiva do backend — lista vazia é config antiga, sem
// como conferir, e a escolhida passa.
export function etiquetaEfetiva(scraping, { mlTags = [], mlDefaultTag = null } = {}) {
  const t = typeof scraping?.mlTag === "string" ? scraping.mlTag.trim() : "";
  if (t && (!mlTags.length || mlTags.some(x => x.tag === t))) return t;
  return mlDefaultTag || null;
}
