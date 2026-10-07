import { useState, useEffect } from "react";
import { PRIMARY, formatDateBR, formatDateTimeBR } from "../../data/constants";
import { getGrupoEstatisticas, errText } from "../../data/api";
import { formatInt } from "../../data/desempenho";
import { periodoGrupos, formatDuracao, formatSaldo, formatPct, textoPrevisao, textoRitmo } from "../../data/grupos";
import AlertBanner from "../ui/AlertBanner";
import StatCard from "../ui/StatCard";
import BarrasPorDia from "../ui/BarrasPorDia";
import { Card, Linha, Chip } from "../desempenho/comum";
import OcupacaoBarra from "./OcupacaoBarra";
import BarrasSaldo from "./BarrasSaldo";
import MapaHorarios from "./MapaHorarios";
import FiltroPeriodo from "./FiltroPeriodo";

const secundario = { fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 };
const titulo = { fontWeight: 500, marginBottom: 10 };
const linkBtn = { background: "transparent", border: "none", padding: "8px 4px", margin: "-8px -4px", color: PRIMARY, fontSize: 13, cursor: "pointer", fontFamily: "inherit" };

const dataCurta = (dia) => formatDateBR(`${dia}T12:00:00Z`);

// Quantas vezes a hora depois de um envio perde mais gente que o resto do dia.
// Abaixo de 1,5× não dá pra dizer que o envio espanta: é variação normal.
function leituraTaxa({ aposEnvio, foraDeEnvio }) {
  if (aposEnvio == null || foraDeEnvio == null) return null;
  if (foraDeEnvio === 0) return aposEnvio > 0 ? "Quase todas as saídas vieram logo depois de um envio." : null;
  const r = aposEnvio / foraDeEnvio;
  if (r >= 1.5) return `Na hora depois de um envio saem ${r.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}× mais pessoas que no resto do tempo — vale espaçar mais os envios.`;
  return "Sem diferença clara: os envios não aumentam as saídas.";
}

function PorDiaGrupo({ dias }) {
  const [serie, setSerie] = useState("saldo");
  const comDado = dias.filter(d => !d.semDados);
  const membros = comDado.filter(d => d.membros != null).map(d => ({ date: d.date, value: d.membros }));
  const envios = comDado.map(d => ({ date: d.date, value: d.envios || 0 }));
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ fontWeight: 500 }}>Por dia</div>
        <Linha>
          <Chip ativo={serie === "saldo"} onClick={() => setSerie("saldo")}>Entradas e saídas</Chip>
          <Chip ativo={serie === "envios"} onClick={() => setSerie("envios")}>Envios</Chip>
          <Chip ativo={serie === "membros"} onClick={() => setSerie("membros")}>Membros</Chip>
        </Linha>
      </div>
      {serie === "saldo" && <BarrasSaldo dias={dias} />}
      {serie === "envios" && (envios.some(d => d.value)
        ? <BarrasPorDia dias={envios} formata={v => `${formatInt(v)} envio(s)`} />
        : <div style={secundario}>Nenhum envio no período.</div>)}
      {serie === "membros" && (membros.length
        ? <BarrasPorDia dias={membros} formata={v => `${formatInt(v)} membros`} />
        : <div style={secundario}>O número de membros é lido a cada 30 minutos enquanto o WhatsApp está conectado. Ainda não há leitura no período.</div>)}
    </Card>
  );
}

export default function DetalheGrupo({ jid, periodoId, onPeriodo, onVoltar, onOpenCampanha }) {
  const [consulta, setConsulta] = useState({ n: 0 });
  const [resposta, setResposta] = useState(null); // { n, chave, dados, erro }
  const chave = `${jid}|${periodoId}`;

  useEffect(() => {
    let viva = true;
    getGrupoEstatisticas(jid, periodoGrupos(periodoId))
      .then(dados => { if (viva) setResposta({ n: consulta.n, chave, dados, erro: null }); })
      .catch(err => { if (viva) setResposta({ n: consulta.n, chave, dados: null, erro: errText(err, "Não foi possível carregar o grupo.") }); });
    return () => { viva = false; };
  }, [jid, periodoId, consulta, chave]);

  const carregando = resposta?.n !== consulta.n || resposta?.chave !== chave;
  const d = resposta?.dados;
  const erro = carregando ? null : resposta?.erro;
  const atualizar = () => setConsulta(c => ({ n: c.n + 1 }));

  return (
    <div>
      <button type="button" onClick={onVoltar} style={{ ...linkBtn, marginBottom: 8 }}>← Todos os grupos</button>
      <h2 style={{ fontSize: 18, fontWeight: 500, margin: "4px 0 6px", overflowWrap: "anywhere" }}>{d?.grupo?.nome || "Grupo"}</h2>
      {d?.grupo?.campanhas?.length > 0 && (
        <div style={{ ...secundario, marginBottom: 14 }}>
          Recebe ofertas de{" "}
          {d.grupo.campanhas.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              {onOpenCampanha
                ? <button type="button" onClick={() => onOpenCampanha(c.id)} style={{ ...linkBtn, fontSize: 12, padding: 0, margin: 0 }}>{c.name}</button>
                : c.name}
            </span>
          ))}
        </div>
      )}

      <FiltroPeriodo periodoId={periodoId} onPeriodo={onPeriodo} onAtualizar={atualizar} carregando={carregando} />

      {erro && <AlertBanner tone="error" message={erro} onRetry={atualizar} />}
      {!d && carregando && <Card style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Carregando…</Card>}

      {d && (
        <div style={{ opacity: carregando ? 0.6 : 1 }}>
          <Card>
            <div style={titulo}>Lotação</div>
            <OcupacaoBarra membros={d.lotacao.membros} cap={d.cap} enchendoEm={d.enchendoEm} />
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginTop: 8, fontSize: 13 }}>
              <span style={{ color: d.grupo.enchendo ? "var(--warn-text)" : undefined }}>
                {d.lotacao.membros == null ? "Membros ainda não lidos" : `${formatInt(d.lotacao.membros)} de ${formatInt(d.cap)} membros (${Math.round((d.lotacao.ocupacao || 0) * 100)}%)`}
              </span>
              {d.lotacao.membros != null && (
                <span>{textoPrevisao(d.lotacao.previsao)}{textoRitmo(d.lotacao.previsao) && <span style={secundario}> · {textoRitmo(d.lotacao.previsao)}</span>}</span>
              )}
            </div>
            <div style={{ ...secundario, marginTop: 6 }}>
              {d.grupo.autoDuplicate && <div>Duplicação automática ligada: um grupo novo é criado quando este chegar a {formatInt(d.lotacao.cap)} membros.</div>}
              {d.lotacao.membrosEm && d.lotacao.membrosEm !== d.to && <div>Última leitura de membros em {dataCurta(d.lotacao.membrosEm)}.</div>}
              {d.lotacao.previsao?.base === "eventos" && <div>Previsão pelas entradas e saídas dos últimos dias — ainda não há leituras diárias suficientes.</div>}
            </div>
          </Card>

          <Totais origem={d.origem} envios={d.aposEnvio.envios} />

          <PorDiaGrupo dias={d.porDia} />

          <Card>
            <div style={titulo}>Origem e permanência</div>
            <div style={{ fontSize: 13, lineHeight: 1.8 }}>
              <div>
                Entraram: <strong>{formatInt(d.origem.entradas.link)}</strong> pelo link · <strong>{formatInt(d.origem.entradas.adicionado)}</strong> adicionadas por um admin
                {d.origem.entradas.outro > 0 && <> · {formatInt(d.origem.entradas.outro)} de outra forma</>}
              </div>
              <div>
                Saíram: <strong>{formatInt(d.origem.saidas.saiu)}</strong> por conta própria · <strong>{formatInt(d.origem.saidas.removido)}</strong> removidas
              </div>
            </div>
            <Permanencia p={d.permanencia} />
            <div style={{ ...secundario, marginTop: 10 }}>
              Entrada aprovada por um admin (grupo com aprovação) aparece como "adicionada".
            </div>
          </Card>

          <Card>
            <div style={titulo}>Saídas após envio</div>
            <AposEnvio a={d.aposEnvio} />
          </Card>

          <Card>
            <MapaHorarios horarios={d.horarios} />
          </Card>

          {d.coletandoDesde && (
            <div style={{ ...secundario, marginBottom: 12 }}>
              Coletando desde {dataCurta(d.coletandoDesde)}. O WhatsApp não guarda o histórico de entradas e saídas: antes disso não há dado.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Totais({ origem, envios }) {
  const entradas = origem.entradas.link + origem.entradas.adicionado + origem.entradas.outro;
  const saidas = origem.saidas.saiu + origem.saidas.removido;
  return (
    <Linha style={{ marginBottom: 12 }}>
      <StatCard label="Entradas" value={formatInt(entradas)} />
      <StatCard label="Saídas" value={formatInt(saidas)} />
      <StatCard label="Saldo" value={formatSaldo(entradas - saidas)} />
      <StatCard label="Envios" value={formatInt(envios)} />
    </Linha>
  );
}

function Permanencia({ p }) {
  if (!p.saidas && !p.entraram) return null;
  const origem = [["pelo link", p.porOrigem?.join_link], ["adicionadas", p.porOrigem?.join_added]].filter(([, o]) => o?.n > 0);
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 13, lineHeight: 1.8 }}>
      {p.comEntrada > 0 && (
        <>
          <div>
            Quem saiu por conta própria ficou em média (mediana) <strong>{formatDuracao(p.medianaMs)}</strong>.
          </div>
          <div style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
            {formatPct(p.pctAte1h)} saíram na primeira hora · {formatPct(p.pctAte24h)} em até 24 h · {formatPct(p.pctAte7d)} em até 7 dias
          </div>
          {origem.length > 0 && (
            <div style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
              {origem.map(([rotulo, o]) => `${rotulo}: ${formatDuracao(o.medianaMs)} (${o.n})`).join(" · ")}
            </div>
          )}
        </>
      )}
      {p.semEntrada > 0 && (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
          {formatInt(p.semEntrada)} saída(s) de quem entrou antes de a coleta começar — sem tempo de permanência.
        </div>
      )}
      {p.entraram > 0 && (
        <div>
          Das <strong>{formatInt(p.entraram)}</strong> entradas do período, <strong>{formatInt(p.aindaNoGrupo)}</strong> continuam no grupo.
        </div>
      )}
    </div>
  );
}

function AposEnvio({ a }) {
  if (!a.envios && !a.saidasAposEnvio) return <div style={secundario}>Nenhum envio no período.</div>;
  if (!a.saidas) return <div style={secundario}>Ninguém saiu por conta própria no período.</div>;
  const leitura = leituraTaxa(a.taxaHora);
  return (
    <div style={{ fontSize: 13, lineHeight: 1.8 }}>
      <div>
        <strong>{formatInt(a.saidasAposEnvio)}</strong> de {formatInt(a.saidas)} saídas ({formatPct(a.pct)}) aconteceram até {a.janelaMin} min depois de um envio.
      </div>
      {a.taxaHora.aposEnvio != null && a.taxaHora.foraDeEnvio != null && (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
          {a.taxaHora.aposEnvio.toLocaleString("pt-BR")} saída(s) por hora logo após um envio × {a.taxaHora.foraDeEnvio.toLocaleString("pt-BR")} no resto do tempo.
        </div>
      )}
      {leitura && <div style={{ marginTop: 4 }}>{leitura}</div>}
      {a.piores.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>Envios com mais saídas logo depois</div>
          {a.piores.map(p => (
            <div key={p.at} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.produto || "Oferta"} <span style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>· {formatDateTimeBR(p.at)}</span>
              </span>
              <span style={{ whiteSpace: "nowrap", color: "var(--danger-text)" }}>−{formatInt(p.saidas)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
