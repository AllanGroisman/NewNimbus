// Os dicionários de rótulo+cor que mais de uma tela de cupom usa.
//
// Moram fora das páginas pelo mesmo motivo do `components/admin/cupomEstilos.js`:
// arquivo que exporta componente E constante quebra o fast refresh do Vite (a
// regra react-refresh/only-export-components). `VERDICT` era do
// AdminCupomPalavra e `OUTCOME_LABEL` do AdminRepasse; a aba Admin › Cupom ›
// Repasse mostra os dois lado a lado e precisa que leiam igual nas três telas.
import { PRIMARY_DARK } from "./constants";

// O que o ML respondeu sobre uma PALAVRA de cupom (`ml_coupon_codes.verdict`).
export const VERDICT = {
  valid: { label: "✅ palavra existe", color: PRIMARY_DARK },
  invalid: { label: "❌ o ML não reconheceu", color: "var(--danger-text)" },
  // Não é veredito sobre a palavra: é o ML que não respondeu ("Tivemos um problema").
  // Dizer "não reconheceu" aqui era mostrar o oposto da verdade.
  indeterminado: { label: "❓ o ML não respondeu", color: "var(--warn-text)" },
};

// O mesmo veredito, curto, pra caber na faixa de metadados do card do log de
// captura (Admin › Repasse), onde ele fica ao lado de "cupom: JBL20". Ali o que se
// pergunta não é o que o ML respondeu, é se aquele código que FOI EMBORA na
// mensagem do cliente tinha sido validado — por isso `null` (nunca testado) é um
// estado de primeira classe aqui, e não a ausência de selo.
export const VERDICT_CURTO = {
  valid: { label: "✅ validado", color: PRIMARY_DARK },
  invalid: { label: "⚠ não validado", color: "var(--danger-text)" },
  indeterminado: { label: "❓ sem resposta do ML", color: "var(--warn-text)" },
  "nao-testado": { label: "⏳ não testado", color: "var(--color-text-secondary)" },
};

// Onde um link visto num grupo líder foi parar (`repasse_capture_log.outcome`).
export const OUTCOME_LABEL = {
  queued: { label: "→ fila", color: "#1B7A43" },
  pending: { label: "→ pendente", color: PRIMARY_DARK },
  discarded: { label: "descartado", color: "var(--warn-text)" },
  duplicate: { label: "duplicata", color: "var(--color-text-secondary)" },
  cooldown: { label: "cooldown", color: "var(--color-text-secondary)" },
  error: { label: "erro", color: "var(--danger-text)" },
};
