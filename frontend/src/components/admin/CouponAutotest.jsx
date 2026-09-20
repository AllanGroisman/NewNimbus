import { useState, useCallback } from "react";
import { PRIMARY_DARK } from "../../data/constants";
import {
  adminRepasseAutotest,
  adminRepasseAutotestSave,
  adminRepasseAutotestRun,
  adminRepasseAutotestLog,
  errText,
} from "../../data/api";
import { cardStyle, inputStyle, labelStyle, botaoSecundario, th, td, segundos } from "./cupomEstilos";

// Admin › Cupom › Repasse: o robô que testa no Mercado Livre os cupons que a
// captura pescou nas legendas dos grupos líderes, e traz a campanha pro sistema.
//
// Antes disso o cupom ia na mensagem do cliente sem ninguém nunca perguntar ao ML
// se o código existia — testar era o botão de cada linha, e o filtro padrão da aba
// era "nunca testados" porque era o estado de quase todas elas.
//
// O card é o freio e o diário ao mesmo tempo, e é de propósito: cada teste abre um
// Chrome com a conta do ML, então quem liga isso precisa ver na MESMA tela quanto
// está gastando por rodada e o que o ML respondeu na última.

// Uma linha por passo do robô. `skip` é a rodada que desistiu — e ela é a mais
// importante de todas, porque é a que explica "por que nada aconteceu?".
const ACTION_LABEL = {
  test: { label: "testou a palavra", color: "var(--color-text-primary)" },
  import: { label: "trouxe a campanha", color: PRIMARY_DARK },
  vitrine: { label: "raspou a vitrine", color: PRIMARY_DARK },
  skip: { label: "rodada pulada", color: "var(--color-text-secondary)" },
};

const VERDICT_LABEL = {
  valid: { label: "✅ existe", color: PRIMARY_DARK },
  invalid: { label: "❌ o ML não reconheceu", color: "var(--danger-text)" },
  indeterminado: { label: "❓ o ML não respondeu", color: "var(--warn-text)" },
};

// Os números que o admin mexe, com a unidade já no rótulo — `intervaloMs` em
// milissegundos num campo de formulário é convite a errar por mil.
const CAMPOS = [
  ["intervaloMinutos", "A cada quantos minutos", "Uma rodada abre um Chrome por palavra."],
  ["maxPorRodada", "Palavras por rodada", "Cada uma leva de 15 a 50 segundos."],
  ["pausaEntrePalavrasSegundos", "Pausa entre palavras (s)", "Rajada de Chrome é o que acorda o anti-robô."],
  ["minCapturas", "Só testar com N capturas", "Palavra vista uma vez só raramente paga o teste."],
  ["diasDeBusca", "Janela de captura (dias)", "O mesmo período que a lista abaixo mostra."],
  ["maxImportsPorRodada", "Campanhas por rodada", "Trazer a campanha leva minutos e ativa o cupom na conta do ML."],
  ["maxTentativas", "Tentativas por palavra", "Vale para quando o ML não responde."],
  ["esperaAposIndeterminadoHoras", "Esperar antes de insistir (h)", "Sem isso o robô reabriria o Chrome na mesma palavra toda rodada."],
  ["pausaAposBloqueioMin", "Pausa após bloqueio (min)", "Depois de um CAPTCHA o robô para e espera este tempo."],
];

// A config guardada fala em ms; o formulário fala em minutos e segundos. A
// conversão mora nas duas funções abaixo e em nenhum outro lugar.
function paraFormulario(cfg) {
  return {
    ...cfg,
    intervaloMinutos: Math.round((cfg.intervaloMs || 0) / 60_000),
    pausaEntrePalavrasSegundos: Math.round((cfg.pausaEntrePalavrasMs || 0) / 1000),
  };
}

function paraServidor(form) {
  const { intervaloMinutos, pausaEntrePalavrasSegundos, ...resto } = form;
  return {
    ...resto,
    intervaloMs: (parseInt(intervaloMinutos, 10) || 0) * 60_000,
    pausaEntrePalavrasMs: (parseInt(pausaEntrePalavrasSegundos, 10) || 0) * 1000,
  };
}

const dataHora = (v) => (v ? new Date(v).toLocaleString("pt-BR") : "—");

function Resumo({ status }) {
  if (!status) return null;
  const bloqueado = status.bloqueadoAte && new Date(status.bloqueadoAte) > new Date();
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, marginBottom: 12 }}>
      <span>
        {status.enabled
          ? <strong style={{ color: PRIMARY_DARK }}>ligado</strong>
          : <strong style={{ color: "var(--color-text-secondary)" }}>desligado</strong>}
      </span>
      <span style={{ color: "var(--color-text-secondary)" }}>última rodada: {dataHora(status.lastRunAt)}</span>
      {status.lastDuration != null && (
        <span style={{ color: "var(--color-text-secondary)" }}>levou {segundos(status.lastDuration)}</span>
      )}
      {status.lastRunAt && (
        <span style={{ color: "var(--color-text-secondary)" }}>
          {status.testados} testada(s) · {status.importados} campanha(s) · {status.vitrines} vitrine(s)
        </span>
      )}
      {status.running && <span style={{ color: PRIMARY_DARK, fontWeight: 500 }}>⟳ rodando agora</span>}
      {status.nextRunAt && !status.running && (
        <span style={{ color: "var(--color-text-secondary)" }}>próxima: {dataHora(status.nextRunAt)}</span>
      )}
      {/* O motivo por que a última rodada não fez nada. Sem isto a tela mostraria
          "0 testadas" e deixaria o admin adivinhando se estava quebrado. */}
      {status.pulada && <span style={{ color: "var(--warn-text)" }}>{status.pulada}</span>}
      {bloqueado && (
        <span style={{ color: "var(--danger-text)", fontWeight: 500 }}>
          o ML barrou — volta a tentar {dataHora(status.bloqueadoAte)}
        </span>
      )}
      {status.lastError && <span style={{ color: "var(--danger-text)" }}>erro: {status.lastError}</span>}
    </div>
  );
}

function Diario({ itens }) {
  if (!itens) return null;
  if (!itens.length) {
    return (
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
        O robô ainda não registrou nada.
      </div>
    );
  }
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ textAlign: "left", color: "var(--color-text-secondary)", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
          <th style={th}>Quando</th>
          <th style={th}>Cupom</th>
          <th style={th}>O que fez</th>
          <th style={th}>Resultado</th>
        </tr>
      </thead>
      <tbody>
        {itens.map(l => {
          const acao = ACTION_LABEL[l.action] || { label: l.action, color: "var(--color-text-primary)" };
          const vd = l.verdict ? VERDICT_LABEL[l.verdict] : null;
          return (
            <tr key={l.id} style={{ borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{dataHora(l.createdAt)}</td>
              <td style={{ ...td, fontFamily: "monospace" }}>{l.code === "-" ? "—" : l.code}</td>
              <td style={{ ...td, color: acao.color }}>
                {acao.label}
                {l.durationMs != null && (
                  <span style={{ color: "var(--color-text-secondary)" }}> · {segundos(l.durationMs)}</span>
                )}
              </td>
              <td style={td}>
                {vd && <span style={{ color: vd.color, fontWeight: 500 }}>{vd.label}</span>}
                {l.produtos != null && <span> {l.produtos} produto(s)</span>}
                {!vd && l.produtos == null && (
                  <span style={{ color: l.ok ? PRIMARY_DARK : "var(--color-text-secondary)" }}>
                    {l.ok ? "ok" : "—"}
                  </span>
                )}
                {l.message && (
                  <div style={{ color: "var(--color-text-secondary)" }}>{l.message}</div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function CouponAutotest() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState(null);
  const [log, setLog] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [rodando, setRodando] = useState(false);
  const [erro, setErro] = useState(null);
  const [salvo, setSalvo] = useState(false);

  const load = useCallback(async () => {
    setCarregando(true);
    try {
      const [r, l] = await Promise.all([adminRepasseAutotest(), adminRepasseAutotestLog({ pageSize: 20 })]);
      setForm(paraFormulario(r.config));
      setStatus(r.status);
      setLog(l.items);
      setErro(null);
    } catch (err) {
      setErro(errText(err, "Não foi possível carregar o teste automático."));
    } finally {
      setCarregando(false);
    }
  }, []);

  // Busca no clique que abre o card, como o CouponDetection: esta config muda uma
  // vez por mês e a aba já faz a sua própria consulta ao abrir.
  function toggle() {
    const abrindo = !open;
    setOpen(abrindo);
    if (abrindo && !form) load();
  }

  function patch(p) {
    setForm(f => ({ ...f, ...p }));
    setSalvo(false);
  }

  async function salvar() {
    setSalvando(true);
    try {
      const r = await adminRepasseAutotestSave(paraServidor(form));
      // A resposta traz a config já saneada pelo servidor (limites aplicados):
      // mostrar ela evita a tela discordar do que foi realmente gravado.
      setForm(paraFormulario(r.config));
      setStatus(r.status);
      setSalvo(true);
      setErro(null);
    } catch (err) {
      setErro(errText(err, "Não foi possível salvar."));
    } finally {
      setSalvando(false);
    }
  }

  async function rodarAgora() {
    setRodando(true);
    setErro(null);
    try {
      await adminRepasseAutotestRun();
      // A rodada segue solta no servidor (é Chrome por palavra). Uma espera curta
      // antes de reler faz a primeira linha do diário já aparecer no clique.
      await new Promise(r => setTimeout(r, 1500));
      await load();
    } catch (err) {
      setErro(errText(err, "Não foi possível disparar a rodada."));
    } finally {
      setRodando(false);
    }
  }

  return (
    <div style={cardStyle}>
      <button
        onClick={toggle}
        style={{ ...botaoSecundario, border: "none", padding: 0, fontSize: 14, fontWeight: 500, width: "100%", textAlign: "left" }}
      >
        {open ? "▾" : "▸"} Teste automático dos cupons
        {status && !open && (
          <span style={{ fontSize: 12, fontWeight: 400, color: "var(--color-text-secondary)" }}>
            {" "}— {status.enabled ? "ligado" : "desligado"}
          </span>
        )}
      </button>

      {open && (
        <div style={{ marginTop: 14 }}>
          <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 0 }}>
            O robô pergunta ao Mercado Livre se a palavra pescada na legenda existe e, quando existe,
            traz a campanha e a vitrine pro sistema. O cupom continua sendo enviado de qualquer forma —
            isto aqui é o que faz alguém <em>saber</em> se ele vale.
          </p>

          {carregando && <div style={{ fontSize: 12 }}>Carregando...</div>}
          {erro && <div style={{ fontSize: 12, color: "var(--danger-text)", marginBottom: 10 }}>{erro}</div>}

          {form && (
            <>
              <Resumo status={status} />

              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 12 }}>
                <input type="checkbox" checked={!!form.enabled} onChange={e => patch({ enabled: e.target.checked })} />
                Testar sozinho, em rodadas
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginBottom: 12 }}>
                {CAMPOS.map(([key, label, hint]) => (
                  <div key={key}>
                    <label style={labelStyle} htmlFor={`autotest-${key}`}>{label}</label>
                    <input
                      id={`autotest-${key}`}
                      type="number"
                      min="0"
                      value={form[key] ?? ""}
                      onChange={e => patch({ [key]: e.target.value })}
                      style={{ ...inputStyle, width: "100%" }}
                    />
                    <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 4 }}>{hint}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <input type="checkbox" checked={!!form.importarCampanha} onChange={e => patch({ importarCampanha: e.target.checked })} />
                  Trazer a campanha da palavra que existe
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <input type="checkbox" checked={!!form.rasparVitrine} onChange={e => patch({ rasparVitrine: e.target.checked })} />
                  Raspar a vitrine de produtos
                </label>
              </div>

              {/* O aviso não é decorativo: importar é a única coisa que este sistema
                  ESCREVE na conta do ML, e quem liga o robô precisa saber disso. */}
              {form.importarCampanha && (
                <div style={{ fontSize: 11, color: "var(--warn-text)", marginBottom: 14 }}>
                  Trazer a campanha ativa o cupom na conta do Mercado Livre (o “Eu quero”) — é a única
                  escrita que o sistema faz lá. Sem ativar, o ML não dá a lista de produtos.
                </div>
              )}

              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 18 }}>
                <button onClick={salvar} disabled={salvando} style={{ ...botaoSecundario, borderColor: PRIMARY_DARK, color: PRIMARY_DARK }}>
                  {salvando ? "Salvando..." : "Salvar"}
                </button>
                <button onClick={rodarAgora} disabled={rodando} style={botaoSecundario}>
                  {rodando ? "⟳ rodando..." : "Rodar agora"}
                </button>
                <button onClick={load} disabled={carregando} style={botaoSecundario}>Atualizar</button>
                {salvo && <span style={{ fontSize: 12, color: PRIMARY_DARK }}>salvo</span>}
              </div>

              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>O que o robô fez</div>
              <Diario itens={log} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
