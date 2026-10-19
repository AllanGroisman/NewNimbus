import { useState } from "react";
import { PRIMARY } from "../../data/constants";
import { Linha, Chip } from "../desempenho/comum";
import {
  PRESETS, resolvePeriodo, deslocaPeriodo, comoPreset, validaPersonalizado, rotuloPeriodo,
} from "../../data/periodos";

// Escolha de período das telas de números: chips de preset, "Escolher datas"
// (um dia só ou um intervalo, com o calendário nativo) e a linha ‹ período › que
// anda pra trás e pra frente no mesmo tamanho. Só os controles — quem usa põe o
// Card e o "↻ Atualizar".
//
// `valor` = { id } (preset) ou { id: "custom", from, to }. `min`/`max`/`maxDias`
// são os limites da tela (o ML só fecha o dia seguinte, a Shopee guarda 3 meses).
// As datas escolhidas à mão só valem no "Ver": aplicar a cada tecla dispararia
// uma busca pesada na loja por data pela metade.

const campoData = {
  padding: "6px 8px",
  borderRadius: 8,
  border: "0.5px solid var(--color-border-tertiary)",
  background: "var(--color-background-secondary)",
  color: "var(--color-text-primary)",
  fontSize: 13,
  fontFamily: "inherit",
  minWidth: 0,
};

const seta = (ativa) => ({
  width: 32,
  height: 32,
  flexShrink: 0,
  borderRadius: 8,
  border: "0.5px solid var(--color-border-secondary)",
  background: "transparent",
  color: "var(--color-text-primary)",
  fontSize: 16,
  lineHeight: 1,
  fontFamily: "inherit",
  cursor: ativa ? "pointer" : "default",
  opacity: ativa ? 1 : 0.35,
});

export default function SeletorPeriodo({ valor, onChange, presets, terminaHoje = false, min = null, max = null, maxDias = null }) {
  const opcoes = { terminaHoje };
  const atual = resolvePeriodo(valor, opcoes);
  const [aberto, setAberto] = useState(false);
  const [de, setDe] = useState("");
  const [ate, setAte] = useState("");
  const [erro, setErro] = useState(null);

  const limites = { min, max };
  const anterior = atual ? deslocaPeriodo({ ...valor, ...atual }, -1, limites) : null;
  const proximo = atual ? deslocaPeriodo({ ...valor, ...atual }, 1, limites) : null;
  // Vizinho que coincide com um preset acende o chip dele de novo.
  const casa = (p) => {
    const preset = comoPreset(p, presets, opcoes);
    return preset.id === "custom" ? p : preset;
  };

  const abre = () => {
    if (aberto) { setAberto(false); return; }
    setDe(atual?.from || "");
    setAte(atual?.to || "");
    setErro(null);
    setAberto(true);
  };
  const mudaDe = (v) => {
    setDe(v);
    setErro(null);
    if (v && ate && v > ate) setAte(v);
  };
  const ver = (e) => {
    e.preventDefault();
    const problema = validaPersonalizado(de, ate, { min, max, maxDias });
    if (problema) { setErro(problema); return; }
    setAberto(false);
    onChange(casa({ id: "custom", from: de, to: ate }));
  };

  return (
    <div>
      <Linha>
        {presets.map(id => (
          <Chip key={id} ativo={valor.id === id} onClick={() => { setAberto(false); if (valor.id !== id) onChange({ id }); }}>
            {PRESETS[id].label}
          </Chip>
        ))}
        <Chip ativo={valor.id === "custom" || aberto} onClick={abre}>Escolher datas</Chip>
      </Linha>

      {aberto && (
        <form onSubmit={ver} style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: "var(--color-text-secondary)" }}>
            De
            <input type="date" value={de} min={min || undefined} max={max || undefined} onChange={e => mudaDe(e.target.value)} style={campoData} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: "var(--color-text-secondary)" }}>
            Até
            <input type="date" value={ate} min={de || min || undefined} max={max || undefined} onChange={e => { setAte(e.target.value); setErro(null); }} style={campoData} />
          </label>
          <button
            type="submit"
            style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: PRIMARY, color: "var(--color-background-primary)", fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}
          >
            Ver
          </button>
          <div role={erro ? "alert" : undefined} style={{ flexBasis: "100%", fontSize: 11, color: erro ? "var(--danger-text)" : "var(--color-text-secondary)" }}>
            {erro || "Para um dia só, use a mesma data nos dois campos."}
          </div>
        </form>
      )}

      {atual && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <button type="button" aria-label="Período anterior" disabled={!anterior} onClick={() => anterior && onChange(casa(anterior))} style={seta(!!anterior)}>‹</button>
          <div style={{ fontSize: 13, fontWeight: 500, textAlign: "center", minWidth: 0, flex: "0 1 auto" }}>{rotuloPeriodo(atual)}</div>
          <button type="button" aria-label="Próximo período" disabled={!proximo} onClick={() => proximo && onChange(casa(proximo))} style={seta(!!proximo)}>›</button>
        </div>
      )}
    </div>
  );
}
