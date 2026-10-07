import { useState, useEffect } from "react";
import { formatDateBR } from "../data/constants";
import { getGruposEstatisticas, errText } from "../data/api";
import { formatInt } from "../data/desempenho";
import { PERIODO_GRUPOS_PADRAO, periodoGrupos, formatSaldo } from "../data/grupos";
import AlertBanner from "../components/ui/AlertBanner";
import StatCard from "../components/ui/StatCard";
import { Card, Linha } from "../components/desempenho/comum";
import FiltroPeriodo from "../components/grupos/FiltroPeriodo";
import BarrasSaldo from "../components/grupos/BarrasSaldo";
import ListaGrupos from "../components/grupos/ListaGrupos";
import DetalheGrupo from "../components/grupos/DetalheGrupo";

// Aba Grupos (task 4): membros, entradas e saídas, envios e lotação dos grupos de
// WhatsApp que recebem campanha. Os grupos entram aqui sozinhos — basta estarem
// como destino de alguma campanha. Tocar num grupo abre o detalhe dele.

const selectStyle = {
  padding: "7px 10px",
  borderRadius: 8,
  border: "0.5px solid var(--color-border-tertiary)",
  background: "var(--color-background-secondary)",
  color: "var(--color-text-primary)",
  fontSize: 13,
  fontFamily: "inherit",
  maxWidth: "100%",
};

const secundario = { fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 };
const dataCurta = (dia) => formatDateBR(`${dia}T12:00:00Z`);

export default function PageGrupos({ onOpenCampanha }) {
  // Mesmo esquema do Desempenho: cada pedido é uma `consulta` numerada, e a
  // resposta guarda o número da que a gerou — resposta atrasada de um filtro
  // antigo nunca sobrescreve a nova.
  const [consulta, setConsulta] = useState({ periodoId: PERIODO_GRUPOS_PADRAO, campanha: "", n: 0 });
  const [resposta, setResposta] = useState(null); // { n, dados, erro }
  const [aberto, setAberto] = useState(null);     // jid do grupo no detalhe

  useEffect(() => {
    let viva = true;
    const { from, to } = periodoGrupos(consulta.periodoId);
    getGruposEstatisticas({ from, to, campanha: consulta.campanha || undefined })
      .then(dados => { if (viva) setResposta({ n: consulta.n, dados, erro: null }); })
      .catch(err => { if (viva) setResposta({ n: consulta.n, dados: null, erro: errText(err, "Não foi possível carregar as estatísticas dos grupos.") }); });
    return () => { viva = false; };
  }, [consulta]);

  const nova = (mudanca) => setConsulta(c => ({ ...c, ...mudanca, n: c.n + 1 }));
  // O detalhe muda o período da lista junto: voltar mostra o mesmo recorte.
  const mudaPeriodo = (periodoId) => { if (periodoId !== consulta.periodoId) nova({ periodoId }); };

  if (aberto) {
    return (
      <DetalheGrupo
        jid={aberto}
        periodoId={consulta.periodoId}
        onPeriodo={mudaPeriodo}
        onVoltar={() => setAberto(null)}
        onOpenCampanha={onOpenCampanha}
      />
    );
  }

  const carregando = resposta?.n !== consulta.n;
  const dados = resposta?.dados || null;
  const erro = carregando ? null : resposta?.erro || null;
  const enchendo = (dados?.grupos || []).filter(g => g.enchendo);

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 500, margin: "0 0 6px" }}>Grupos</h2>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>
        Quem entra e sai dos grupos que recebem suas campanhas, e quando eles vão lotar.
      </div>

      <FiltroPeriodo periodoId={consulta.periodoId} onPeriodo={mudaPeriodo} onAtualizar={() => nova({})} carregando={carregando}>
        {dados?.campanhas?.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <select
              aria-label="Campanha"
              value={consulta.campanha}
              onChange={e => nova({ campanha: e.target.value })}
              style={selectStyle}
            >
              <option value="">Todas as campanhas</option>
              {dados.campanhas.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        {dados && (
          <div style={{ ...secundario, marginTop: 10 }}>
            {dataCurta(dados.from)}{dados.to !== dados.from && <> a {dataCurta(dados.to)}</>}
          </div>
        )}
      </FiltroPeriodo>

      {erro && <AlertBanner tone="error" message={erro} onRetry={() => nova({})} />}
      {!dados && carregando && <Card style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Carregando…</Card>}

      {dados && dados.grupos.length === 0 && !consulta.campanha && (
        <Card style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          Nenhum grupo recebe campanhas ainda — vincule grupos na aba Grupos de uma campanha e eles aparecem aqui.
        </Card>
      )}

      {dados && (dados.grupos.length > 0 || consulta.campanha) && (
        <div style={{ opacity: carregando ? 0.6 : 1 }}>
          {enchendo.length > 0 && (
            <AlertBanner
              tone="warn"
              message={enchendo.length === 1
                ? `"${enchendo[0].nome}" está perto de lotar (${formatInt(enchendo[0].membros)} de ${formatInt(dados.cap)}).`
                : `${enchendo.length} grupos estão perto de lotar.`}
            />
          )}

          <Linha style={{ marginBottom: 12 }}>
            <StatCard label="Membros" value={formatInt(dados.totais.membros)} sub={`em ${formatInt(dados.totais.grupos)} grupo(s)`} />
            <StatCard label="Entradas" value={formatInt(dados.totais.entradas)} />
            <StatCard label="Saídas" value={formatInt(dados.totais.saidas)} />
            <StatCard label="Saldo" value={formatSaldo(dados.totais.saldo)} />
            <StatCard label="Envios" value={formatInt(dados.totais.envios)} />
          </Linha>

          {dados.porDia.length > 1 && (
            <Card>
              <div style={{ fontWeight: 500, marginBottom: 10 }}>Entradas e saídas por dia</div>
              <BarrasSaldo dias={dados.porDia} />
            </Card>
          )}

          {dados.grupos.length > 0
            ? <ListaGrupos grupos={dados.grupos} cap={dados.cap} enchendoEm={dados.enchendoEm} onAbrir={setAberto} />
            : <Card style={secundario}>Essa campanha não tem grupo de destino.</Card>}

          <div style={{ ...secundario, margin: "12px 0" }}>
            {dados.coletandoDesde
              ? <>Coletando desde {dataCurta(dados.coletandoDesde)}. </>
              : <>A coleta começa assim que o WhatsApp do grupo estiver conectado. </>}
            O WhatsApp não guarda o histórico de entradas e saídas, então não há dado de antes disso.
          </div>
        </div>
      )}
    </div>
  );
}
