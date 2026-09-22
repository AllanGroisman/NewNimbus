// Admin › Cupom › aba "Config Test" — o diagnóstico do que a colheita de vitrines
// precisa para funcionar, com o conserto na mesma tela.
//
// Existe porque as três dependências moravam em lugares diferentes e nenhuma era
// conferível de onde a colheita é disparada:
//
//   1. A EXTENSÃO do coletor (`extension/`), que abre a vitrine numa aba deste
//      Chrome. Sem ela o botão de colher simplesmente sumia da outra aba.
//   2. O COOKIE da conta do ML do sistema, em Admin › ML — outra página.
//   3. A TAG de afiliado da mesma conta. É a que mais engana: aparece como
//      detalhe do cookie, mas sem ela `criarLinkAfiliadoMLSistema` recusa, e é
//      dela que depende a landing de afiliado — o caminho BARATO de ler uma
//      vitrine (`backend/scraping/ml-vitrine-landing.js`). Sem tag, a rodada cai
//      no caminho caro, o navegador no servidor, que o ML barra com CAPTCHA.
//
// Cada item é um card com semáforo, o motivo, e o campo pra corrigir ali mesmo.
// No fim, o diagnóstico ponta a ponta: ele é o único que prova cookie E tag
// funcionando de verdade contra o ML, em vez de "estão preenchidos".
import { useState, useEffect, useCallback } from "react";
import {
  adminScraperMLSession, adminScraperMLSessionSave, adminScraperMLSessionTest,
  adminMlCupons, adminMlCuponsStatus, adminMlCuponsDiagnosticoLink, errText,
} from "../data/api";
import { coletorInfo, raparVitrine, _resetColetor } from "../data/coletor";
import MLSourcesSection from "../components/admin/MLSourcesSection";
import ExtensaoAusente from "../components/admin/ExtensaoAusente";
import ColheitaLog from "../components/admin/ColheitaLog";
import { Config } from "../components/admin/LimitesCupons";
import { cardStyle, inputStyle, labelStyle, botaoPrimario, botaoSecundario, segundos } from "../components/admin/cupomEstilos";

// Um cookie do ML dura cerca de uma semana. Passado disso ele quase sempre já
// caiu, mesmo que o último teste tenha dado certo — por isso a idade vira aviso
// sozinha, sem precisar de um teste novo.
const COOKIE_VELHO_DIAS = 7;

const SEMAFORO = {
  ok:     { icone: "✅", cor: "var(--color-text-primary)",  borda: "var(--color-border-tertiary)", fundo: "var(--color-background-primary)" },
  aviso:  { icone: "⚠️", cor: "var(--warn-text)",           borda: "var(--warn-border)",           fundo: "var(--warn-bg)" },
  erro:   { icone: "❌", cor: "var(--danger-text)",         borda: "var(--danger-border)",         fundo: "var(--danger-bg)" },
  neutro: { icone: "…",  cor: "var(--color-text-secondary)", borda: "var(--color-border-tertiary)", fundo: "var(--color-background-primary)" },
};

const dias = (iso) => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
};

const quando = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR") : "nunca");

export default function ConfigTest() {
  const [sessao, setSessao] = useState(null);
  const [extensao, setExtensao] = useState(null);   // { instalada, versao }
  const [status, setStatus] = useState(null);       // status da rodada, para o Config
  const [erro, setErro] = useState(null);

  const [tick, setTick] = useState(0);
  const recarregar = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const [s, st] = await Promise.all([adminScraperMLSession(), adminMlCuponsStatus()]);
        if (!vivo) return;
        setSessao(s);
        setStatus(st);
        setErro(null);
      } catch (err) {
        if (vivo) setErro(errText(err, "Não deu pra carregar a configuração."));
      }
    })();
    return () => { vivo = false; };
  }, [tick]);

  // A extensão é perguntada de novo a cada recarga porque o conserto dela é FORA
  // da página (instalar/religar em chrome://extensions), e o resultado fica
  // memoizado no módulo — sem o reset, "instalei agora" nunca apareceria.
  const perguntarExtensao = useCallback(() => {
    _resetColetor();
    setExtensao(null);
    coletorInfo().then(setExtensao);
  }, []);
  useEffect(() => { coletorInfo().then(setExtensao); }, []);

  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 16, lineHeight: 1.6 }}>
        O que a colheita de vitrines precisa pra funcionar, conferido aqui e consertado aqui.
        Nada nesta aba mexe nos cupons guardados.
      </div>

      {erro && (
        <div style={{ ...cardStyle, background: "var(--danger-bg)", borderColor: "var(--danger-border)", color: "var(--danger-text)", fontSize: 12 }}>
          {erro}
        </div>
      )}

      <CardExtensao info={extensao} onRever={perguntarExtensao} />
      <CardCookie sessao={sessao} onSaved={recarregar} />
      <CardTag sessao={sessao} onSaved={recarregar} />
      <MLSourcesSection />

      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Limites das duas etapas</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4, lineHeight: 1.5 }}>
          Os mesmos da aba “Cupons do ML” — quantas páginas da lista, quantos produtos por cupom,
          e se a busca de produtos pode clicar em “Eu quero”.
        </div>
        <Config config={status?.config} labels={status?.groupingLabels} onSaved={recarregar} />
      </div>

      <Diagnostico sessao={sessao} extensao={extensao} onRever={perguntarExtensao} />
    </div>
  );
}

// O esqueleto de um item do diagnóstico: semáforo, título, veredito e o conserto.
function Card({ tom, titulo, veredito, children, acoes }) {
  const t = SEMAFORO[tom] || SEMAFORO.neutro;
  return (
    <div style={{ ...cardStyle, background: t.fundo, borderColor: t.borda }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
        <span>{t.icone}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500 }}>{titulo}</div>
          <div style={{ fontSize: 12, color: t.cor, marginTop: 3, lineHeight: 1.5 }}>{veredito}</div>
        </div>
        {acoes}
      </div>
      {children && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

// Os comandos que a versão de hoje da extensão precisa entender. Uma cópia antiga
// responde ao ping e não conhece os novos — e aí o botão da tela fica cinza sem
// explicação. Listar aqui é o que transforma isso em diagnóstico.
const COMANDOS_ESPERADOS = [
  ["lista", "puxar a lista de cupons"],
  ["raspar", "colher a vitrine de um cupom"],
  ["palavra", "testar uma palavra"],
  ["checkout", "testar um cupom no checkout"],
];

function CardExtensao({ info, onRever }) {
  const comandos = info?.comandos || [];
  const faltando = info?.instalada ? COMANDOS_ESPERADOS.filter(([c]) => !comandos.includes(c)) : [];
  const tom = info === null ? "neutro" : !info.instalada ? "erro" : faltando.length ? "aviso" : "ok";
  return (
    <Card
      tom={tom}
      titulo="Extensão — cupons no meu Chrome"
      veredito={
        info === null ? "perguntando…"
          : !info.instalada
            ? "não respondeu. Sem ela os cupons só rodam pelo navegador do servidor, que o ML barra com CAPTCHA."
            : faltando.length
              ? `respondeu${info.versao ? ` — versão ${info.versao}` : ""}, mas é uma cópia antiga: ela não faz ${faltando.map(([, o]) => o).join(", ")}.`
              : `respondeu${info.versao ? ` — versão ${info.versao}` : ""}. É ela que abre as páginas do ML numa aba deste Chrome.`
      }
      acoes={<button onClick={onRever} style={botaoSecundario}>Perguntar de novo</button>}
    >
      {info && !info.instalada && <ExtensaoAusente compacto />}
      {!!faltando.length && (
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          Recarregue a extensão da pasta <code>extension/</code> em <code>chrome://extensions</code> (↻)
          e dê F5 nesta página. Enquanto isso, o que falta continua rodando pelo servidor.
        </div>
      )}
    </Card>
  );
}

function CardCookie({ sessao, onSaved }) {
  const [cookie, setCookie] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [testando, setTestando] = useState(false);
  const [msg, setMsg] = useState(null);

  const doEnv = sessao?.source === "env";
  const idade = dias(sessao?.updatedAt);

  let tom = "neutro", veredito = "carregando…";
  if (sessao) {
    if (!sessao.configured) {
      tom = "erro";
      veredito = "não tem cookie salvo. Sem ele nada da conta do sistema abre — nem a lista de cupons, nem o Hub.";
    } else if (sessao.lastCheckOk === false) {
      tom = "erro";
      veredito = `o último teste falhou: ${sessao.lastCheckReason || "sem motivo registrado"}.`;
    } else if (idade !== null && idade >= COOKIE_VELHO_DIAS) {
      tom = "aviso";
      veredito = `salvo há ${idade} dia(s). O cookie do ML costuma cair nessa idade — teste antes de rodar a colheita.`;
    } else if (!sessao.lastCheckAt) {
      tom = "aviso";
      veredito = "salvo, mas nunca testado. “Testar acesso ao Hub” é o que diz se ele entra de verdade.";
    } else {
      tom = "ok";
      veredito = `salvo (${sessao.cookieLength} caracteres) e o último teste passou.`;
    }
  }

  async function salvar() {
    setSalvando(true);
    setMsg(null);
    try {
      await adminScraperMLSessionSave({ cookie: cookie.trim() });
      setCookie("");
      setMsg({ tom: "ok", texto: "Cookie salvo. Teste o acesso ao Hub pra confirmar que ele entra." });
      onSaved();
    } catch (err) {
      setMsg({ tom: "erro", texto: errText(err, "Não deu pra salvar o cookie.") });
    } finally {
      setSalvando(false);
    }
  }

  async function testar() {
    setTestando(true);
    setMsg(null);
    try {
      const r = await adminScraperMLSessionTest();
      setMsg({ tom: r.ok ? "ok" : "erro", texto: r.reason });
      onSaved();
    } catch (err) {
      setMsg({ tom: "erro", texto: errText(err, "Não deu pra abrir o Hub agora.") });
      onSaved();
    } finally {
      setTestando(false);
    }
  }

  return (
    <Card
      tom={tom}
      titulo="Cookie da conta do Mercado Livre do sistema"
      veredito={veredito}
      acoes={
        <button
          onClick={testar}
          disabled={testando || !sessao?.configured}
          title={sessao?.configured ? "Abre o Hub num navegador de verdade (~30s)" : "Salve o cookie primeiro"}
          style={{ ...botaoSecundario, cursor: (testando || !sessao?.configured) ? "not-allowed" : "pointer", opacity: (testando || !sessao?.configured) ? 0.5 : 1 }}
        >
          {testando ? "Testando…" : "Testar acesso ao Hub"}
        </button>
      }
    >
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 8 }}>
        Última checagem: {quando(sessao?.lastCheckAt)}
        {sessao?.updatedAt ? ` · colado em ${quando(sessao.updatedAt)}` : ""}
      </div>
      {doEnv ? (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          Este cookie vem de variável de ambiente (<code>ML_AFFILIATE_COOKIE</code>) — o servidor recusa gravar por cima.
          Pra trocar, mexa no ambiente e reinicie.
        </div>
      ) : (
        <>
          <label style={labelStyle}>Colar um cookie novo</label>
          <textarea
            value={cookie}
            onChange={e => setCookie(e.target.value)}
            rows={3}
            placeholder="Cole aqui o cookie copiado pela extensão Extrator Nimbus"
            style={{ ...inputStyle, width: "100%", fontFamily: "monospace", fontSize: 11 }}
          />
          <button onClick={salvar} disabled={salvando || !cookie.trim()} style={{ ...botaoPrimario(salvando || !cookie.trim()), marginTop: 8 }}>
            {salvando ? "Salvando…" : "Salvar cookie"}
          </button>
        </>
      )}
      {msg && <Recado {...msg} />}
    </Card>
  );
}

function CardTag({ sessao, onSaved }) {
  const [tag, setTag] = useState(null);   // null = ninguém mexeu
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState(null);

  const doEnv = sessao?.source === "env";
  const tom = !sessao ? "neutro" : sessao.tag ? "ok" : "erro";

  async function salvar() {
    setSalvando(true);
    setMsg(null);
    try {
      await adminScraperMLSessionSave({ tag: (tag || "").trim() });
      setTag(null);
      setMsg({ tom: "ok", texto: "Tag salva." });
      onSaved();
    } catch (err) {
      setMsg({ tom: "erro", texto: errText(err, "Não deu pra salvar a tag.") });
    } finally {
      setSalvando(false);
    }
  }

  const valor = tag === null ? (sessao?.tag || "") : tag;
  const mudou = tag !== null && tag.trim() !== (sessao?.tag || "");

  return (
    <Card
      tom={tom}
      titulo="Tag de afiliado da conta do sistema"
      veredito={
        !sessao ? "carregando…"
          : sessao.tag
            ? <>preenchida (<strong>{sessao.tag}</strong>).</>
            : "não preenchida — e é ela que faz a landing de afiliado abrir. Sem tag, ler a vitrine de um cupom só pelo navegador do servidor, que o ML barra."
      }
    >
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 8, lineHeight: 1.5 }}>
        Não tem nada a ver com a tag de nenhum cliente — os links dos grupos continuam saindo com a tag de cada um.
      </div>
      {doEnv ? (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          Vem de variável de ambiente (<code>ML_SCRAPER_TAG</code> / <code>ML_AFFILIATE_TAG</code>) — não dá pra editar por aqui.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={valor}
            onChange={e => setTag(e.target.value)}
            placeholder="ex.: pb20260221170529"
            style={{ ...inputStyle, width: 260 }}
          />
          <button onClick={salvar} disabled={salvando || !mudou} style={botaoPrimario(salvando || !mudou)}>
            {salvando ? "Salvando…" : "Salvar tag"}
          </button>
        </div>
      )}
      {msg && <Recado {...msg} />}
    </Card>
  );
}

function Recado({ tom, texto }) {
  const t = SEMAFORO[tom] || SEMAFORO.neutro;
  return (
    <div style={{ marginTop: 10, fontSize: 12, color: t.cor, background: t.fundo, border: `0.5px solid ${t.borda}`, borderRadius: 8, padding: "8px 10px" }}>
      {texto}
    </div>
  );
}

// O diagnóstico ponta a ponta.
//
// Os cards acima dizem "está preenchido"; este diz "funciona". Ele encadeia os
// seis passos na ordem em que a colheita real depende deles e PARA no primeiro que
// falha — seguir depois de um ❌ só produziria erros derivados.
//
// Não grava nada: a vitrine colhida no passo 5 é jogada fora de propósito. Quem
// grava é o botão de colher da outra aba.
function Diagnostico({ sessao, extensao, onRever }) {
  const [rodando, setRodando] = useState(false);
  const [eventos, setEventos] = useState([]);
  const [resumo, setResumo] = useState(null);

  const rodar = async () => {
    setRodando(true);
    setEventos([]);
    setResumo(null);
    const t0 = Date.now();
    const log = [];
    const push = (tipo, texto) => {
      log.push({ at: new Date().toISOString(), tipo, texto });
      setEventos([...log]);
    };
    // Cada passo devolve o que o próximo precisa, ou `null` pra parar a linha.
    const parar = (texto) => {
      push("erro", texto);
      setResumo({
        titulo: "Diagnóstico interrompido",
        tom: "erro",
        nota: texto,
        numeros: [{ label: "Passos concluídos", valor: log.filter(e => e.tipo === "ok").length }, { label: "Duração", valor: segundos(Date.now() - t0) }],
      });
      setRodando(false);
      return null;
    };

    try {
      // 1. extensão — perguntada de novo, não pelo estado da tela: ela pode ter
      // sido instalada depois que esta página montou.
      push("info", "1/6 · perguntando pela extensão do coletor…");
      _resetColetor();
      const ext = await coletorInfo();
      onRever();
      if (!ext.instalada) return parar("A extensão não respondeu. Instale-a e recarregue esta página.");
      const faltando = COMANDOS_ESPERADOS.filter(([c]) => !(ext.comandos || []).includes(c));
      push(faltando.length ? "aviso" : "ok",
        `1/6 · extensão respondeu${ext.versao ? ` (versão ${ext.versao})` : ""}${faltando.length ? ` — cópia antiga: falta ${faltando.map(([c]) => c).join(", ")}` : ` — entende ${(ext.comandos || []).length} comando(s)`}`);

      // 2. cookie, contra o ML de verdade
      if (!sessao?.configured) return parar("Não há cookie da conta do sistema salvo.");
      push("info", "2/6 · abrindo o Hub de Afiliados com o cookie do sistema (~30s)…");
      const hub = await adminScraperMLSessionTest();
      if (!hub.ok) return parar(`O cookie não entrou no Hub: ${hub.reason}`);
      push("ok", `2/6 · o cookie entrou — ${hub.reason}`);

      // 3. tag
      const tagAtual = hub.session?.tag || sessao?.tag;
      if (!tagAtual) return parar("A tag de afiliado da conta do sistema está vazia.");
      push("ok", `3/6 · tag preenchida (${tagAtual})`);

      // 4. um cupom real com vitrine pra usar de cobaia
      push("info", "4/6 · procurando um cupom com vitrine pra testar…");
      const r = await adminMlCupons({ page: 1, pageSize: 20, onlyValid: true });
      const alvo = (r.items || []).find(c => c.containerUrl);
      if (!alvo) {
        push("aviso", "4/6 · nenhum cupom guardado tem vitrine — rode o “Puxar cupons agora” antes.");
        setResumo({
          titulo: "Diagnóstico parcial",
          tom: "aviso",
          nota: "Extensão, cookie e tag estão de pé. Faltou um cupom com vitrine pra testar a colheita de verdade — puxe os cupons na aba “Cupons do ML” e rode de novo.",
          numeros: [{ label: "Passos concluídos", valor: 3 }, { label: "Duração", valor: segundos(Date.now() - t0) }],
        });
        setRodando(false);
        return null;
      }
      push("ok", `4/6 · usando “${alvo.title || alvo.campaignId}”`);

      // 5. a colheita em si, uma página só, sem gravar
      push("info", "5/6 · abrindo a vitrine numa aba (nada será gravado)…");
      const vitrine = await raparVitrine(alvo.containerUrl, {
        paginas: 1,
        onProgresso: (p) => push(p.tipo === "muro" ? "aviso" : "info",
          p.tipo === "muro"
            ? "o Mercado Livre pediu verificação — resolva na aba que abriu"
            : `página ${p.pagina} · ${p.produtos} produto(s)`),
      });
      if (!vitrine.produtos.length) return parar(`A vitrine abriu, mas não devolveu produto nenhum${vitrine.motivo ? ` (${vitrine.motivo})` : ""}.`);
      push("ok", `5/6 · ${vitrine.produtos.length} produto(s) lidos${vitrine.parcial ? " (parcial)" : ""} — descartados, isto é só o teste`);

      // 6. cookie + tag juntos, no ML. É o passo que nenhum campo preenchido prova.
      push("info", "6/6 · gerando um link de afiliado do sistema pro primeiro produto…");
      const link = await adminMlCuponsDiagnosticoLink(vitrine.produtos[0].link);
      if (!link.ok) return parar(`O ML não gerou o link de afiliado (${link.kind}): ${link.reason}`);
      push("ok", `6/6 · link gerado: ${link.shortUrl}`);

      setResumo({
        titulo: "Tudo funcionando",
        tom: "ok",
        nota: "A colheita de vitrines tem tudo de que precisa: extensão, cookie válido e tag gerando link.",
        numeros: [
          { label: "Passos concluídos", valor: 6 },
          { label: "Produtos lidos no teste", valor: vitrine.produtos.length },
          { label: "Duração", valor: segundos(Date.now() - t0) },
        ],
      });
    } catch (err) {
      parar(errText(err, "O diagnóstico parou com um erro."));
      return null;
    } finally {
      setRodando(false);
    }
    return null;
  };

  return (
    <div style={cardStyle}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>Diagnóstico ponta a ponta</div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
        Percorre os seis passos que a colheita percorre — extensão, cookie no Hub, tag, um cupom com vitrine,
        a leitura da vitrine numa aba, e o link de afiliado — e para no primeiro que falhar.
        <b> Não grava nada.</b> Demora ~1 minuto e abre uma aba do Chrome.
      </div>
      <button
        onClick={rodar}
        disabled={rodando || extensao === null}
        style={botaoPrimario(rodando || extensao === null)}
      >
        {rodando ? "⟳ Rodando…" : "Rodar diagnóstico completo"}
      </button>
      <ColheitaLog eventos={eventos} resumo={resumo} rodando={rodando} titulo={rodando ? "Onde o diagnóstico está" : "O que o diagnóstico encontrou"} />
    </div>
  );
}
