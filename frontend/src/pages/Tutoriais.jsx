import { useState, useEffect, useRef, useMemo } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";

// ─── ESTRUTURA DE TUTORIAIS ──────────────────────────────────────────────
// Cada tutorial tem `id` (slug) usado pra deep-link das outras páginas.
// Pra criar tutorial novo: adicionar entry em TUTORIAL_SECTIONS abaixo.
// Pra escrever o conteúdo: trocar o `content` (atualmente é um placeholder)
// por JSX/markdown — pode ser uma função que retorna JSX.
//
// Pra linkar de outra página (ex: AffiliateML): chamar onNavigate("tutorials", { tutorialId: "afiliado-ml" })
//
// IDs exportados em TUTORIAL_IDS pra evitar erros de digitação nos chamadores.
// ─────────────────────────────────────────────────────────────────────────

export const TUTORIAL_IDS = {
  // Começando
  PRIMEIRA_CAMPANHA: "primeira-campanha",
  CONECTAR_WHATSAPP: "conectar-whatsapp",
  CRIAR_CONTA: "criar-conta",
  // Afiliados
  AFILIADO_ML: "afiliado-ml",
  AFILIADO_AMAZON: "afiliado-amazon",
  AFILIADO_SHOPEE: "afiliado-shopee",
  // Campanhas
  FILTROS_CATALOGO: "filtros-catalogo",
  TEMPLATES_MENSAGEM: "templates-mensagem",
  AGENDAMENTO: "agendamento",
  BUSCAR_CATALOGO: "buscar-catalogo",
  ADICIONAR_LINK_MANUAL: "adicionar-link-manual",
  // Conta
  TROCAR_PLANO: "trocar-plano",
  RESET_SENHA: "reset-senha",
};

// Placeholder padrão pra cada tutorial — substituir pelo conteúdo real depois.
function Placeholder({ title }) {
  return (
    <div style={{ background: "var(--color-background-secondary)", border: "0.5px dashed var(--color-border-secondary)", borderRadius: 8, padding: 16, fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
      <strong style={{ color: "var(--color-text-primary)" }}>{title}</strong> — tutorial em produção.
      <br />
      Em breve: passo a passo, screenshots e troubleshooting. Por enquanto, fala com o suporte se precisar
      de ajuda com esse tópico.
    </div>
  );
}

const TUTORIAL_SECTIONS = [
  {
    id: "comecando",
    title: "Começando",
    description: "Configure sua conta e crie sua primeira campanha",
    icon: "▶",
    tutorials: [
      { id: TUTORIAL_IDS.CRIAR_CONTA,        title: "Criar conta e verificar email", duration: "2 min" },
      { id: TUTORIAL_IDS.CONECTAR_WHATSAPP,  title: "Conectar um número de WhatsApp", duration: "3 min" },
      { id: TUTORIAL_IDS.PRIMEIRA_CAMPANHA,  title: "Criar sua primeira campanha", duration: "5 min" },
    ],
  },
  {
    id: "afiliados",
    title: "Configurar afiliados (gerar comissão)",
    description: "Sem afiliado configurado, a campanha fica pausada — links não geram comissão.",
    icon: "◆",
    tutorials: [
      { id: TUTORIAL_IDS.AFILIADO_ML,     title: "Configurar afiliado do Mercado Livre", duration: "4 min" },
      { id: TUTORIAL_IDS.AFILIADO_AMAZON, title: "Configurar afiliado da Amazon",         duration: "3 min" },
      { id: TUTORIAL_IDS.AFILIADO_SHOPEE, title: "Configurar afiliado da Shopee",         duration: "5 min" },
    ],
  },
  {
    id: "campanhas",
    title: "Gerenciar campanhas",
    description: "Filtros, fila, agendamento e templates de mensagem",
    icon: "◎",
    tutorials: [
      { id: TUTORIAL_IDS.BUSCAR_CATALOGO,       title: "Buscar produtos do catálogo", duration: "3 min" },
      { id: TUTORIAL_IDS.ADICIONAR_LINK_MANUAL, title: "Adicionar link manualmente (URL)", duration: "2 min" },
      { id: TUTORIAL_IDS.FILTROS_CATALOGO,      title: "Filtros avançados do catálogo", duration: "4 min" },
      { id: TUTORIAL_IDS.TEMPLATES_MENSAGEM,    title: "Personalizar templates de mensagem", duration: "3 min" },
      { id: TUTORIAL_IDS.AGENDAMENTO,           title: "Configurar janelas de envio", duration: "3 min" },
    ],
  },
  {
    id: "conta",
    title: "Conta e cobrança",
    description: "Plano, pagamento e recuperação de senha",
    icon: "★",
    tutorials: [
      { id: TUTORIAL_IDS.TROCAR_PLANO, title: "Mudar de plano ou cancelar", duration: "2 min" },
      { id: TUTORIAL_IDS.RESET_SENHA,  title: "Recuperar/trocar senha", duration: "1 min" },
    ],
  },
];

// Lookup id → { section, tutorial } pra deep-link rápido.
const TUTORIAL_INDEX = (() => {
  const m = new Map();
  for (const s of TUTORIAL_SECTIONS) {
    for (const t of s.tutorials) m.set(t.id, { section: s, tutorial: t });
  }
  return m;
})();

export default function PageTutoriais({ targetTutorialId = null }) {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState(targetTutorialId);
  const refs = useRef(new Map());

  // Deep-link: ao receber targetTutorialId (vindo de outra página), abre
  // o tutorial e rola até ele.
  useEffect(() => {
    if (!targetTutorialId) return;
    setOpenId(targetTutorialId);
    // pequeno delay pra garantir que o DOM montou antes do scroll
    const t = setTimeout(() => {
      const el = refs.current.get(targetTutorialId);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
    return () => clearTimeout(t);
  }, [targetTutorialId]);

  // Filtragem por busca — match em title da seção, do tutorial e na description da seção.
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TUTORIAL_SECTIONS;
    return TUTORIAL_SECTIONS
      .map(s => {
        const sectionMatch = s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
        const tutorials = sectionMatch
          ? s.tutorials
          : s.tutorials.filter(t => t.title.toLowerCase().includes(q));
        return tutorials.length ? { ...s, tutorials } : null;
      })
      .filter(Boolean);
  }, [query]);

  const totalCount = useMemo(
    () => TUTORIAL_SECTIONS.reduce((n, s) => n + s.tutorials.length, 0),
    []
  );

  return (
    <div style={{ maxWidth: 880 }}>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 4 }}>Tutoriais</h2>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 18 }}>
        Aprenda a usar o Nimbus passo a passo — desde a primeira campanha até filtros avançados e afiliados.
      </div>

      {/* Busca */}
      <div style={{ position: "relative", marginBottom: 18 }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={`Buscar entre ${totalCount} tutoriais…`}
          style={{
            width: "100%", padding: "10px 12px 10px 36px", borderRadius: 10,
            border: "0.5px solid var(--color-border-tertiary)",
            background: "var(--color-background-primary)",
            fontSize: 13, fontFamily: "inherit",
            color: "var(--color-text-primary)",
            boxSizing: "border-box",
          }}
        />
        <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "var(--color-text-secondary)" }}>⌕</span>
        {query && (
          <button
            onClick={() => setQuery("")}
            style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: 14, padding: 4 }}
            title="Limpar busca"
          >×</button>
        )}
      </div>

      {sections.length === 0 && (
        <div style={{ background: "var(--color-background-primary)", border: "0.5px dashed var(--color-border-secondary)", borderRadius: 10, padding: 24, textAlign: "center", fontSize: 13, color: "var(--color-text-secondary)" }}>
          Nada encontrado pra <strong style={{ color: "var(--color-text-primary)" }}>"{query}"</strong>.
        </div>
      )}

      {sections.map(section => (
        <div key={section.id} style={{ marginBottom: 26 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 16, color: PRIMARY }}>{section.icon}</span>
            <h3 style={{ fontSize: 15, fontWeight: 500, margin: 0 }}>{section.title}</h3>
            <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>· {section.tutorials.length} tutoriai{section.tutorials.length !== 1 ? "s" : "l"}</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>
            {section.description}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {section.tutorials.map(t => {
              const isOpen = openId === t.id;
              return (
                <div
                  key={t.id}
                  ref={el => { if (el) refs.current.set(t.id, el); }}
                  style={{
                    background: "var(--color-background-primary)",
                    border: `0.5px solid ${isOpen ? PRIMARY : "var(--color-border-tertiary)"}`,
                    borderRadius: 10,
                    overflow: "hidden",
                    transition: "border-color 0.15s",
                  }}
                >
                  <button
                    onClick={() => setOpenId(isOpen ? null : t.id)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      gap: 10, padding: "12px 14px",
                      width: "100%", background: "transparent", border: "none", cursor: "pointer",
                      textAlign: "left", color: "var(--color-text-primary)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                      <span style={{
                        width: 22, height: 22, borderRadius: "50%",
                        background: isOpen ? PRIMARY : PRIMARY_LIGHT,
                        color: isOpen ? "#fff" : PRIMARY_DARK,
                        fontSize: 11, fontWeight: 600,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        flexShrink: 0, transition: "all 0.15s",
                      }}>▶</span>
                      <span style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                      <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{t.duration}</span>
                      <span style={{
                        fontSize: 10, padding: "2px 7px", borderRadius: 5,
                        background: "var(--color-background-secondary)",
                        color: "var(--color-text-secondary)",
                        border: "0.5px solid var(--color-border-tertiary)",
                        fontWeight: 500,
                      }}>Em breve</span>
                      <span style={{ fontSize: 12, color: "var(--color-text-secondary)", width: 12, textAlign: "center" }}>
                        {isOpen ? "▾" : "▸"}
                      </span>
                    </div>
                  </button>
                  {isOpen && (
                    <div style={{ padding: "0 14px 14px" }}>
                      {t.content ? t.content : <Placeholder title={t.title} />}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Rodapé */}
      <div style={{ marginTop: 30, padding: 16, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        Não encontrou o que procurava? Entre em contato com o suporte pelo WhatsApp ou email — vamos
        adicionar tutoriais com base no que você precisar.
      </div>
    </div>
  );
}

// Helper exportado pra outras páginas validarem deep-links em tempo de
// desenvolvimento (TUTORIAL_INDEX é só interno).
export function hasTutorial(id) {
  return TUTORIAL_INDEX.has(id);
}
