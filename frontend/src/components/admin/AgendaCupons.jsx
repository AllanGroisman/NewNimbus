// A agenda de UMA etapa de cupons (task 3): liga/desliga e os horários, dentro do
// card da etapa, ao lado dos limites dela.
//
// Quem guarda e marca o horário vencido é o servidor (backend/coupons/agenda.js);
// quem RODA é esta aba aberta — as etapas só existem no Chrome do admin, pela
// extensão. Por isso o aviso fixo embaixo: agenda que ninguém executa é o
// "horário não rodou" chegando no grupo.
import { useState } from "react";
import { adminMlCuponsSaveConfig, errText } from "../../data/api";
import ScheduleField from "../ui/ScheduleField";
import Toggle from "../ui/Toggle";
import { botaoSecundario } from "./cupomEstilos";

const nota = { fontSize: 11, color: "var(--color-text-secondary)", marginTop: 8, lineHeight: 1.5 };

function quando(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// `botao` é "lista" | "produtos" | "tudo" — a mesma chave do `ultimas` e da agenda.
export default function AgendaEtapa({ botao, config, proximo, onSaved }) {
  const salvo = config?.agenda?.[botao] || null;
  // Estado derivado, como o `useRascunho` dos limites: copiar prop pra estado num
  // efeito desfaria a edição a cada volta do poll de status.
  const [edit, setEdit] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(null);
  const ag = edit || salvo;
  if (!ag) return null;

  const mudar = (parcial) => setEdit({ ...ag, ...parcial });
  const salvar = async () => {
    setSalvando(true); setErro(null);
    try {
      // Só a etapa deste card: o `writeConfig` mescla por botão.
      await adminMlCuponsSaveConfig({ agenda: { [botao]: ag } });
      setEdit(null);
      onSaved?.();
    } catch (err) {
      setErro(errText(err, "Não deu pra salvar a agenda."));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <Toggle value={!!ag.enabled} onChange={v => mudar({ enabled: v })} label="Rodar sozinha nos horários" />
        <span style={{ fontSize: 12 }}>Rodar sozinha</span>
        {salvo?.enabled && proximo && !edit && (
          <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>· próxima: {quando(proximo)}</span>
        )}
      </div>

      {ag.enabled && (
        <ScheduleField
          idPrefix={`agenda-${botao}`}
          mode={ag.scheduleMode}
          intervalMinutes={ag.intervalMinutes}
          times={ag.times}
          minInterval={30}
          onChange={mudar}
        />
      )}

      <div style={nota}>
        Roda <b>nesta aba</b>: deixe Admin › Cupom › Cupons do ML aberta neste Chrome, com a extensão.
        Se ela estiver fechada (ou ocupada com outra etapa) por mais de 15 minutos depois do horário,
        ele é pulado e o grupo de admin recebe o aviso.
      </div>

      <div style={{ marginTop: 12 }}>
        <button onClick={salvar} disabled={salvando || !edit} style={botaoSecundario}>
          {salvando ? "salvando…" : "salvar a agenda desta etapa"}
        </button>
      </div>
      {erro && <div style={{ ...nota, color: "var(--danger-text)" }}>{erro}</div>}
    </div>
  );
}
