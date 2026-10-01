import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import { TOURS } from "../data/onboarding";
import { tutoriaisGet, errText } from "../data/api";

// ─── ESTRUTURA DE TUTORIAIS ──────────────────────────────────────────────
// O conteúdo NÃO mora mais aqui: as seções e os tutoriais vêm de
// GET /api/tutoriais e são editados em Admin › Editar Tutoriais (task 102).
//
// O que continua sendo código é o `id` (slug) dos tutoriais que outras páginas
// referenciam por deep-link — TUTORIAL_IDS abaixo. Ele casa com a coluna `slug`
// do banco; renomear o slug pela tela do admin quebra o link de quem chama
// onNavigate("tutorials", { tutorialId: "afiliado-ml" }).
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

// Mostrado quando o tutorial ainda não tem nem texto nem vídeo cadastrado.
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

// URL de embed do YouTube a partir do que o admin colou. Aceita as três formas
// que as pessoas copiam na prática (watch?v=, youtu.be/ e /embed/). Devolve null
// quando não reconhece — aí a UI mostra um link em vez de um iframe quebrado.
export function youtubeEmbedUrl(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "");
  let id = null;
  if (host === "youtu.be") id = u.pathname.slice(1);
  else if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else if (u.pathname.startsWith("/embed/")) id = u.pathname.slice("/embed/".length);
    else if (u.pathname.startsWith("/shorts/")) id = u.pathname.slice("/shorts/".length);
  }
  if (!id) return null;
  id = id.split("/")[0];
  if (!/^[\w-]{6,20}$/.test(id)) return null;
  return `https://www.youtube.com/embed/${id}`;
}

// Corpo do tutorial aberto: player (quando tem vídeo) + passo a passo em texto.
// O iframe só existe quando o acordeão está aberto — montar os 13 de uma vez
// custaria uma requisição ao YouTube por tutorial só pra abrir a página.
export function TutorialBody({ tutorial }) {
  const embed = youtubeEmbedUrl(tutorial.videoUrl);
  const temTexto = !!(tutorial.content || "").trim();
  if (!embed && !tutorial.videoUrl && !temTexto) return <Placeholder title={tutorial.title} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {embed && (
        <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 9", borderRadius: 8, overflow: "hidden", background: "#000" }}>
          <iframe
            src={embed}
            title={tutorial.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }}
          />
        </div>
      )}
      {!embed && tutorial.videoUrl && (
        <a href={tutorial.videoUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: PRIMARY, fontWeight: 500 }}>
          Assistir o vídeo ↗
        </a>
      )}
      {temTexto && (
        <div style={{ fontSize: 13, lineHeight: 1.7, color: "var(--color-text-primary)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {tutorial.content}
        </div>
      )}
    </div>
  );
}

// ─── TOURS (task 39) ─────────────────────────────────────────────────────
// Os tours que rodam em cima do sistema podem ser refeitos daqui a qualquer
// momento — inclusive os que já foram vistos.
function GuiasInterativos({ onboarding, onStartTour, onArmCampaignTour }) {
  if (!onboarding) return null;
  const seen = onboarding.tours || {};

  const guias = [
    {
      id: "tour-main",
      title: TOURS.main.title,
      desc: TOURS.main.description,
      done: !!seen.main,
      action: () => onStartTour?.("main"),
      cta: "Começar agora",
    },
    {
      id: "tour-campaign",
      title: TOURS.campaign.title,
      desc: `${TOURS.campaign.description} Começa quando você abrir uma campanha.`,
      done: !!seen.campaign,
      action: onArmCampaignTour,
      cta: "Mostrar na próxima campanha",
    },
  ];

  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 16, color: PRIMARY }}>✨</span>
        <h3 style={{ fontSize: 15, fontWeight: 500, margin: 0 }}>Tours guiados</h3>
        <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>· mostram onde fica cada coisa</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>
        Rodam por cima da tela de verdade, destacando um item de cada vez. Pode refazer quando
        quiser — nada é apagado nem alterado.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {guias.map(g => (
          <div
            key={g.id}
            style={{
              display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
              background: "var(--color-background-primary)",
              border: "0.5px solid var(--color-border-tertiary)",
              borderRadius: 10, padding: "12px 14px",
            }}
          >
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 8 }}>
                {g.title}
                {g.done && (
                  <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", border: "0.5px solid var(--color-border-tertiary)", fontWeight: 500 }}>
                    concluído
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{g.desc}</div>
            </div>
            <button
              onClick={g.action}
              style={{ padding: "7px 14px", borderRadius: 8, background: g.done ? "var(--color-background-secondary)" : PRIMARY, color: g.done ? "var(--color-text-primary)" : "#fff", border: "none", fontSize: 12, cursor: "pointer", fontWeight: 500, flexShrink: 0 }}
            >
              {g.done ? "Refazer" : g.cta}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PageTutoriais({ targetTutorialId = null, onboarding = null, onStartTour, onArmCampaignTour }) {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState(targetTutorialId);
  const [allSections, setAllSections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const refs = useRef(new Map());

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await tutoriaisGet();
      setAllSections(r.sections || []);
    } catch (err) {
      setError(errText(err, "Não foi possível carregar os tutoriais. Tente novamente."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Deep-link: ao receber targetTutorialId (vindo de outra página), abre
  // o tutorial e rola até ele. Depende de `allSections` porque o conteúdo chega
  // por rede — antes dele carregar a linha do tutorial ainda não existe no DOM.
  useEffect(() => {
    if (!targetTutorialId || !allSections.length) return;
    setOpenId(targetTutorialId);
    // pequeno delay pra garantir que o DOM montou antes do scroll
    const t = setTimeout(() => {
      const el = refs.current.get(targetTutorialId);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
    return () => clearTimeout(t);
  }, [targetTutorialId, allSections]);

  // Filtragem por busca — match em title da seção, do tutorial e na description da seção.
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allSections;
    return allSections
      .map(s => {
        const sectionMatch = s.title.toLowerCase().includes(q) || (s.description || "").toLowerCase().includes(q);
        const tutorials = sectionMatch
          ? s.tutorials
          : s.tutorials.filter(t => t.title.toLowerCase().includes(q));
        return tutorials.length ? { ...s, tutorials } : null;
      })
      .filter(Boolean);
  }, [query, allSections]);

  const totalCount = useMemo(
    () => allSections.reduce((n, s) => n + s.tutorials.length, 0),
    [allSections]
  );

  return (
    <div style={{ maxWidth: 880 }}>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 4 }}>Tutoriais</h2>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 18 }}>
        Aprenda a usar o Nimbus passo a passo — desde a primeira campanha até filtros avançados e afiliados.
      </div>

      {/* Tours interativos — a busca abaixo filtra só os tutoriais escritos,
          então eles ficam fora dela. */}
      <GuiasInterativos
        onboarding={onboarding}
        onStartTour={onStartTour}
        onArmCampaignTour={onArmCampaignTour}
      />

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
            className="hit"
            style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: 14, padding: 4 }}
            title="Limpar busca"
          >×</button>
        )}
      </div>

      {loading && (
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: 24, textAlign: "center", fontSize: 13, color: "var(--color-text-secondary)" }}>
          Carregando tutoriais…
        </div>
      )}

      {!loading && error && (
        <div style={{ background: "var(--danger-bg, var(--color-background-secondary))", border: "0.5px solid var(--color-border-secondary)", borderRadius: 10, padding: 20, fontSize: 13, color: "var(--color-text-primary)" }}>
          {error}
          <button
            onClick={load}
            style={{ marginLeft: 12, padding: "5px 12px", borderRadius: 6, background: PRIMARY, color: "#fff", border: "none", fontSize: 12, cursor: "pointer", fontWeight: 500 }}
          >Tentar de novo</button>
        </div>
      )}

      {!loading && !error && sections.length === 0 && (
        <div style={{ background: "var(--color-background-primary)", border: "0.5px dashed var(--color-border-secondary)", borderRadius: 10, padding: 24, textAlign: "center", fontSize: 13, color: "var(--color-text-secondary)" }}>
          {query
            ? <>Nada encontrado pra <strong style={{ color: "var(--color-text-primary)" }}>"{query}"</strong>.</>
            : "Nenhum tutorial publicado ainda."}
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
              // Chaveado por `slug`, não pelo uuid: é o slug que as outras
              // páginas mandam em onOpenTutorial().
              const isOpen = openId === t.slug;
              const pronto = !!(t.videoUrl || (t.content || "").trim());
              return (
                <div
                  key={t.id}
                  ref={el => { if (el) refs.current.set(t.slug, el); }}
                  style={{
                    background: "var(--color-background-primary)",
                    border: `0.5px solid ${isOpen ? PRIMARY : "var(--color-border-tertiary)"}`,
                    borderRadius: 10,
                    overflow: "hidden",
                    transition: "border-color 0.15s",
                  }}
                >
                  <button
                    onClick={() => setOpenId(isOpen ? null : t.slug)}
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
                      {!pronto && (
                        <span style={{
                          fontSize: 10, padding: "2px 7px", borderRadius: 5,
                          background: "var(--color-background-secondary)",
                          color: "var(--color-text-secondary)",
                          border: "0.5px solid var(--color-border-tertiary)",
                          fontWeight: 500,
                        }}>Em breve</span>
                      )}
                      <span style={{ fontSize: 12, color: "var(--color-text-secondary)", width: 12, textAlign: "center" }}>
                        {isOpen ? "▾" : "▸"}
                      </span>
                    </div>
                  </button>
                  {isOpen && (
                    <div style={{ padding: "0 14px 14px" }}>
                      <TutorialBody tutorial={t} />
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
// desenvolvimento. Confere contra TUTORIAL_IDS, não contra o banco: é uma
// checagem de erro de digitação no código, e o conteúdo agora é editável pelo
// admin (um slug renomeado por lá só deixa o acordeão não abrir).
export function hasTutorial(id) {
  return Object.values(TUTORIAL_IDS).includes(id);
}
