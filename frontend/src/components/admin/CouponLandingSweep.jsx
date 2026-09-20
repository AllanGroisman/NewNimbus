import { useState, useCallback, useEffect, useRef } from "react";
import { PRIMARY_DARK } from "../../data/constants";
import {
  adminCuponsLandingSweep,
  adminCuponsLandingSweepSave,
  adminCuponsLandingSweepRun,
  errText,
} from "../../data/api";
import { cardStyle, inputStyle, labelStyle, botaoSecundario, segundos } from "./cupomEstilos";
import Numero from "./Numero";

// Admin › Cupom › Cupons do ML: a varredura que faz os PRODUTOS do sistema
// carregarem os cupons que valem neles (backend/coupons/landing-sweep.js).
//
// Em 19/09/2026 eram ~2.800 cupons guardados, 4.035 produtos no catálogo e UM com
// cupom: os produtos dos cupons não estavam no catálogo. Esta varredura lê a prévia
// da vitrine de cada cupom pela landing de afiliado (sem navegador, sem CAPTCHA) e
// traz as amostras dos cards — tudo já carimbado com o cupom.
//
// Fica ANTES do botão "2 · Buscar produtos dos que faltam" de propósito: ela roda
// sozinha e traz a prévia; o botão 2 abre a vitrine COMPLETA no Chrome do admin, e
// passa a começar pelos cupons que a landing não conseguiu ler.

const CAMPOS = [
  ["intervaloMinutos", "A cada quantos minutos", "Cada rodada gera um link curto por cupom na conta do sistema."],
  ["maxPorRodada", "Cupons por rodada", "~2 s cada, sem navegador."],
  ["pausaSegundos", "Pausa entre pedidos (s)", "Mais um sorteio de até o mesmo tanto — intervalo exato é assinatura de robô."],
  ["refazerHoras", "Reler a landing depois de (h)", "A prévia muda; o cupom sem produto ganha outra chance."],
  ["maxAmostrasPorRodada", "Amostras por rodada", "As miniaturas do card, que chegam sem nome nem preço."],
  ["refazerAmostraDias", "Retentar amostra depois de (dias)", "Anúncio pausado não é buscado de novo toda rodada."],
  ["pausaAposBloqueioMin", "Pausa após bloqueio (min)", "Depois de um CAPTCHA a varredura para e espera."],
];

function paraFormulario(cfg) {
  return {
    ...cfg,
    intervaloMinutos: Math.round((cfg.intervaloMs || 0) / 60_000),
    pausaSegundos: Math.round((cfg.pausaMs || 0) / 1000),
  };
}

function paraServidor(form) {
  const { intervaloMinutos, pausaSegundos, ...resto } = form;
  return {
    ...resto,
    intervaloMs: (parseInt(intervaloMinutos, 10) || 0) * 60_000,
    pausaMs: (parseInt(pausaSegundos, 10) || 0) * 1000,
  };
}

const dataHora = (v) => (v ? new Date(v).toLocaleString("pt-BR") : "—");
const num = (v) => (Number(v) || 0).toLocaleString("pt-BR");

function Cobertura({ c }) {
  if (!c) return null;
  const v = c.vinculos || {};
  return (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, marginBottom: 14 }}>
      <Numero label="Produtos do catálogo com cupom" valor={num(c.produtosComCupom)} />
      <Numero label="Cupons com prévia lida" valor={num(c.comPrevia)} />
      <Numero label="Cupons ainda não lidos" valor={num(Math.max(0, (c.comUrl || 0) - (c.tentados || 0)))} />
      <Numero label="Amostras sem produto ainda" valor={num(c.amostrasSemProduto)} />
      <Numero label="Vínculos: prévia · vitrine · amostra" valor={`${num(v.landing)} · ${num(v.vitrine)} · ${num(v.amostra)}`} />
    </div>
  );
}

function Resumo({ status }) {
  if (!status) return null;
  const bloqueado = status.bloqueadoAte && new Date(status.bloqueadoAte) > new Date();
  const a = status.amostras;
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, marginBottom: 12 }}>
      <span>
        {status.enabled
          ? <strong style={{ color: PRIMARY_DARK }}>ligada</strong>
          : <strong style={{ color: "var(--color-text-secondary)" }}>desligada</strong>}
      </span>
      <span style={{ color: "var(--color-text-secondary)" }}>última rodada: {dataHora(status.lastRunAt)}</span>
      {status.lastDuration != null && (
        <span style={{ color: "var(--color-text-secondary)" }}>levou {segundos(status.lastDuration)}</span>
      )}
      {status.lastRunAt && (
        <span style={{ color: "var(--color-text-secondary)" }}>
          {status.lidos} cupom(ns) lido(s) · {status.comPrevia} com prévia · {status.produtos} produto(s)
          {a ? ` · ${a.trazidas} de ${a.tentadas} amostra(s) trazida(s)` : ""}
        </span>
      )}
      {status.running && (
        <span style={{ color: PRIMARY_DARK, fontWeight: 500 }}>
          ⟳ rodando{status.progresso?.de ? ` — ${status.progresso.i}/${status.progresso.de}: ${status.progresso.title}` : status.progresso?.title ? ` — ${status.progresso.title}` : ""}
        </span>
      )}
      {status.nextRunAt && !status.running && (
        <span style={{ color: "var(--color-text-secondary)" }}>próxima: {dataHora(status.nextRunAt)}</span>
      )}
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

export default function CouponLandingSweep({ onRodou }) {
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState(null);
  const [cobertura, setCobertura] = useState(null);
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(null);
  const [salvo, setSalvo] = useState(false);
  const rodavaRef = useRef(false);

  // `tick` é o "relê": a busca mora dentro do efeito (com o `vivo` pra resposta
  // atrasada de uma aba que já saiu não escrever em estado morto), e quem quer
  // reler só incrementa.
  const [tick, setTick] = useState(0);
  const load = useCallback(() => setTick(t => t + 1), []);

  // Abre carregado: o número de "produtos com cupom" é a resposta à pergunta da
  // task, e ele precisa estar à vista sem clique.
  useEffect(() => {
    let vivo = true;
    adminCuponsLandingSweep()
      .then(r => {
        if (!vivo) return;
        setForm(f => f || paraFormulario(r.config));
        setStatus(r.status);
        setCobertura(r.cobertura);
        setErro(null);
      })
      .catch(err => { if (vivo) setErro(errText(err, "Não foi possível carregar a varredura.")); })
      .finally(() => { if (vivo) setCarregando(false); });
    return () => { vivo = false; };
  }, [tick]);

  // Enquanto roda, relê a cada poucos segundos — a rodada leva minutos e a tela
  // muda de "rodando 12/60" para o resumo. Ao terminar, avisa a página (a tabela de
  // cupons e o botão 2 dependem do que a varredura gravou).
  useEffect(() => {
    if (!status?.running) {
      if (rodavaRef.current) { rodavaRef.current = false; onRodou?.(); }
      return undefined;
    }
    rodavaRef.current = true;
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
  }, [status, load, onRodou]);

  function patch(p) {
    setForm(f => ({ ...f, ...p }));
    setSalvo(false);
  }

  async function salvar() {
    setSalvando(true);
    try {
      const r = await adminCuponsLandingSweepSave(paraServidor(form));
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
    setErro(null);
    try {
      const r = await adminCuponsLandingSweepRun();
      setStatus(r.status);
      await new Promise(res => setTimeout(res, 1500));
      load();
    } catch (err) {
      setErro(errText(err, "Não foi possível disparar a rodada."));
    }
  }

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>Produtos com cupom (varredura sem navegador)</div>
      <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 0 }}>
        Lê a prévia da vitrine de cada cupom (3 a 8 produtos) pela landing de afiliado e traz as miniaturas
        dos cards — sem abrir navegador e sem ativar nada na conta. Os produtos entram no catálogo já com o cupom.
        A prévia prova que o cupom vale naqueles produtos; a lista completa continua sendo o botão 2, no seu Chrome.
      </p>

      {erro && <div style={{ fontSize: 12, color: "var(--danger-text)", marginBottom: 10 }}>{erro}</div>}
      <Cobertura c={cobertura} />
      <Resumo status={status} />

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: aberto ? 14 : 0 }}>
        <button onClick={rodarAgora} disabled={!!status?.running} style={{ ...botaoSecundario, borderColor: PRIMARY_DARK, color: PRIMARY_DARK }}>
          {status?.running ? "⟳ rodando..." : "Rodar agora"}
        </button>
        <button onClick={() => { setCarregando(true); load(); }} disabled={carregando} style={botaoSecundario}>Atualizar</button>
        <button onClick={() => setAberto(a => !a)} style={botaoSecundario}>{aberto ? "▾" : "▸"} Configurar</button>
      </div>

      {aberto && form && (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 12 }}>
            <input type="checkbox" checked={!!form.enabled} onChange={e => patch({ enabled: e.target.checked })} />
            Varrer sozinho, em rodadas
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 12 }}>
            <input type="checkbox" checked={!!form.enriquecerAmostras} onChange={e => patch({ enriquecerAmostras: e.target.checked })} />
            Trazer as amostras dos cards pro catálogo
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginBottom: 12 }}>
            {CAMPOS.map(([key, label, hint]) => (
              <div key={key}>
                <label style={labelStyle} htmlFor={`sweep-${key}`}>{label}</label>
                <input
                  id={`sweep-${key}`}
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
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 12 }}>
            Produto que entra pelas amostras vem sem a nossa categoria: aparece na busca sem filtro de categoria e no
            filtro “só com cupom do ML”.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={salvar} disabled={salvando} style={{ ...botaoSecundario, borderColor: PRIMARY_DARK, color: PRIMARY_DARK }}>
              {salvando ? "Salvando..." : "Salvar"}
            </button>
            {salvo && <span style={{ fontSize: 12, color: PRIMARY_DARK }}>salvo</span>}
          </div>
        </>
      )}
    </div>
  );
}
