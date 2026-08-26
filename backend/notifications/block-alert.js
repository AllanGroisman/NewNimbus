// Aviso ao admin quando a MESMA parede se repete no scraping — o buraco do item 104,
// em que o Mercado Livre recusou tudo por horas e a única pista era o log de admin.
//
// A regra que manda aqui é "nunca um aviso por link". Um CAPTCHA num link é rotina;
// noventa seguidos é incidente. Por isso são DUAS travas antes de qualquer mensagem:
//
//   1. N falhas seguidas do mesmo tipo (contador deste módulo) — mata a falha isolada;
//   2. X minutos contínuos sem nenhum sucesso (o `stateAlert` do user-notifier, que já
//      existia e já foi testado) — mata a rajada curta que se resolve sozinha.
//
// A chave é global por loja+tipo, não por usuário: o CAPTCHA do item 104 é do navegador
// do SERVIDOR e atinge todo mundo — um aviso por cliente seria o spam que queremos
// evitar. Quem sofreu vai citado na mensagem. (Cookie de afiliado vencido, que é mesmo
// por cliente, tem evento próprio: ver affiliate-alert.js.)
const { stateAlert } = require("./user-notifier");
const adminNotifier = require("./admin-notifier");
const { ERROR_KINDS, BLOCK_KINDS, KIND } = require("../repasse/error-kinds");

const MIN_FAILS = Number(process.env.BLOCK_ALERT_MIN_FAILS) || 5;
const GRACE_MS = Number(process.env.BLOCK_ALERT_GRACE_MS) || 15 * 60 * 1000;

// Ponte de vocabulário. O Hub e os cupons classificam a parede com palavras próprias
// (`login` | `captcha` | `verificacao` | `empty` | `sem-modelo`) e o repasse usa o KIND
// fechado do error-kinds. Traduzimos na ENTRADA, para o resto do módulo — e a mensagem —
// falarem uma língua só. Não unificar os três vocabulários é proposital: seria uma
// refatoração grande em código que funciona.
//
// `verificacao` (a conta do sistema sob análise do ML) vira login-wall porque a saída é
// a mesma — mexer na conta —, e o `alvo` diz que é a conta de sistema.
const WALL_TO_KIND = {
  login: KIND.LOGIN_WALL,
  verificacao: KIND.LOGIN_WALL,
  captcha: KIND.CAPTCHA,
  timeout: KIND.TIMEOUT,
};

function normalizeKind(kind) {
  if (!kind) return null;
  if (BLOCK_KINDS.has(kind)) return kind;      // já é KIND do error-kinds
  return WALL_TO_KIND[kind] || null;           // vocabulário do Hub/cupons
}

// key -> { fails, firstAt, users:Set<string>, reason }
const streaks = new Map();

// O coração: conta a sequência e só então arma o stateAlert.
//
// `ok === true` é prova de que a parede caiu (a página abriu), então zera tudo. Um
// descarte por "não é produto" também chega aqui como ok: ali a página ABRIU, o link é
// que não servia.
function noteBlock(key, ok, { kind, reason, userId, alvo } = {}) {
  if (ok) {
    streaks.delete(key);
    stateAlert(key, false, {
      graceMs: GRACE_MS,
      onRecover: () => adminNotifier.notifyBlockRecovered({
        alvo,
        motivo: ERROR_KINDS[kind]?.label || kind || "O bloqueio",
      }),
    });
    return;
  }

  const st = streaks.get(key) || { fails: 0, firstAt: Date.now(), users: new Set(), reason: null };
  st.fails += 1;
  st.reason = reason || st.reason;
  if (userId) st.users.add(String(userId));
  streaks.set(key, st);

  if (st.fails < MIN_FAILS) return;

  // A partir daqui o stateAlert manda: rearmar não duplica aviso, e recuperar dentro
  // da carência cala a boca sozinho.
  stateAlert(key, true, {
    graceMs: GRACE_MS,
    onDown: async () => {
      const cat = ERROR_KINDS[kind] || {};
      await adminNotifier.notifyBlockDetected({
        alvo,
        motivo: cat.label || kind || "Bloqueio",
        o_que: cat.what || st.reason || "",
        o_que_fazer: cat.action || "",
        falhas: st.fails,
        desde: formatTime(st.firstAt),
        clientes: await clientesBlock(st.users),
      });
    },
  });
}

function formatTime(ms) {
  return new Date(ms).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

// "Clientes atingidos: Allan, Marina" — bloco vazio quando não se aplica (Hub/cupons
// usam a conta do sistema, não a de ninguém). O renderTemplate já apaga a linha vazia.
// Nome é conveniência: se o banco não responder, o id serve.
//
// Com muitos clientes a lista vira parede de texto e some com o que importa (o motivo
// e o que fazer), então mostra os primeiros e conta o resto.
const MAX_CLIENTES = 8;

async function clientesBlock(users) {
  if (!users || users.size === 0) return "";
  const ids = [...users];
  const mostrar = ids.slice(0, MAX_CLIENTES);
  let nomes = mostrar;
  try {
    const { prisma } = require("../db");
    const rows = await prisma().user.findMany({ where: { id: { in: mostrar } }, select: { id: true, name: true } });
    const byId = new Map(rows.map(r => [r.id, r.name]));
    nomes = mostrar.map(id => byId.get(id) || id);
  } catch { /* nome é enfeite; o aviso não pode depender do banco */ }
  const resto = ids.length - mostrar.length;
  return `Clientes atingidos: ${nomes.join(", ")}${resto > 0 ? ` e mais ${resto}` : ""}\n`;
}

// ── Pontos de entrada ──────────────────────────────────────────────────────

// Repasse: o desfecho de um scrape de produto. `ok` é "a página abriu" — inclusive
// quando o que abriu não era produto, porque ali parede não houve.
function repasseScrapeResult({ store, ok, kind, reason, userId } = {}) {
  const loja = store || "loja desconhecida";
  const alvo = `Repasse · ${loja}`;
  const k = normalizeKind(kind);
  if (!ok && k) { noteBlock(`repasse:${loja}:${k}`, false, { kind: k, reason, userId, alvo }); return; }
  // Scrape que falhou por outra coisa (rede, erro do navegador) não é parede — mas
  // também não prova que a parede caiu, então deixa a sequência como está.
  if (!ok) return;
  // O sucesso não sabe QUAL parede caiu, então limpa todas as desta loja.
  for (const bk of BLOCK_KINDS) noteBlock(`repasse:${loja}:${bk}`, true, { kind: bk, alvo });
}

// Hub + cupons: a conta de sistema do ML é uma só, e o bloqueio dela derruba os dois.
// Chamado do recordMLHubCheck, que já é o funil de todos esses caminhos.
function mlSessionResult({ ok, kind, reason } = {}) {
  const alvo = "Hub e cupons do ML (conta do sistema)";
  const k = normalizeKind(kind);
  if (!ok && k) { noteBlock(`ml-session:${k}`, false, { kind: k, reason, alvo }); return; }
  // Falhar por algo que não é parede (vitrine vazia, sem modelo de cupom) não é
  // bloqueio — mas também não é prova de que a parede caiu, então não zera nada.
  if (!ok) return;
  for (const bk of BLOCK_KINDS) noteBlock(`ml-session:${bk}`, true, { kind: bk, alvo });
}

function __clearStreaks() { streaks.clear(); }

module.exports = { repasseScrapeResult, mlSessionResult, normalizeKind, MIN_FAILS, GRACE_MS, __clearStreaks };
