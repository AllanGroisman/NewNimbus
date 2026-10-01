// Os objetos de estilo das telas de Cupom (Admin › Cupom).
//
// Vivem fora das páginas porque as três — `AdminCupomML`, `AdminCupomConfig` e o
// `ColheitaLog` — usam os mesmos, e `AdminCupomML` importa o `ColheitaLog`: deixar
// os estilos lá dentro fecharia um ciclo de import. Arquivo `.js` e sem componente
// nenhum de propósito: misturar os dois quebra o fast refresh do Vite.
import { PRIMARY } from "../../data/constants";

export const cardStyle = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 18 };
// maxWidth: as telas dão larguras fixas (240, 280px) em cima deste estilo, e no
// celular elas passavam da borda do card.
export const inputStyle = { padding: "7px 10px", borderRadius: 7, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", maxWidth: "100%" };
export const labelStyle = { fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 };
export const th = { padding: "6px 8px", fontWeight: 500, whiteSpace: "nowrap" };
export const td = { padding: "8px", verticalAlign: "top" };
export const botaoPrimario = (off) => ({
  padding: "9px 18px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 500,
  background: PRIMARY, color: "#fff", cursor: off ? "not-allowed" : "pointer", opacity: off ? 0.6 : 1,
});
export const botaoSecundario = {
  padding: "7px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer",
  border: "1px solid var(--color-border-tertiary)", background: "transparent", color: "var(--color-text-primary)",
};
// O gatilho da ação destrutiva: outline suave, como no "Apagar todos" do catálogo.
// O vermelho sólido fica só no botão de confirmar, dentro do modal.
export const botaoPerigo = (off) => ({
  padding: "7px 14px", borderRadius: 8, fontSize: 12,
  border: "1px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)",
  cursor: off ? "not-allowed" : "pointer", opacity: off ? 0.5 : 1,
});
export const botaoLink = {
  padding: "3px 8px", borderRadius: 6, fontSize: 11, cursor: "pointer",
  border: "1px solid var(--color-border-tertiary)", background: "transparent", color: "var(--color-text-primary)",
};

// Milissegundos viram "30s", "2min e 20s", "1h 4min e 40s" (task 21): passando de
// um minuto, segundo solto não se lê. Partes zeradas somem ("1h e 20s", "2min").
// Mora aqui porque os resumos de colheita, o autoteste e a sonda usam.
export const segundos = (ms) => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const partes = [h && `${h}h`, m && `${m}min`, s && `${s}s`].filter(Boolean);
  return partes.length > 1 ? `${partes.slice(0, -1).join(" ")} e ${partes.at(-1)}` : partes[0];
};

// O formato de um cupom, em três linhas. Sobem para cá — junto com o `segundos` —
// porque a aba "Descobrir palavra" passou a mostrar o cupom que a palavra apontou,
// e ele precisa aparecer ali com a mesma cara que tem na tabela de "Cupons do ML".
// Duas cópias do `desconto` era o começo de duas telas discordando sobre o mesmo
// cupom.
export const brl = (v) => (typeof v === "number" ? `R$ ${v.toFixed(2).replace(".", ",")}` : "—");
export const dia = (v) => (v ? new Date(v).toLocaleDateString("pt-BR") : "—");

// O desconto do cupom em uma linha: "20%" ou "R$ 90".
export const desconto = (c) => {
  if (c?.kind === "percent" && c.value != null) return `${c.value}%`;
  if (c?.value != null) return brl(c.value);
  return "—";
};
