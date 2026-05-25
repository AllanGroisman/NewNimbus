const appConfig = require("../config");

const CONFIG_KEY = "admin-notifications-config";

const DEFAULT_CONFIG = {
  enabled: false,
  userId: null,
  numberId: null,
  groupJid: null,
  groupName: null,
  events: {
    scraping: true,
    errors: true,
    systemOnline: true,
  },
};

function readConfig() {
  const raw = appConfig.get(CONFIG_KEY);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    events: { ...DEFAULT_CONFIG.events, ...(raw.events || {}) },
  };
}

function writeConfig(cfg) {
  const current = readConfig();
  const next = {
    ...current,
    ...cfg,
    events: { ...current.events, ...(cfg.events || {}) },
  };
  next.enabled = !!next.enabled;
  appConfig.set(CONFIG_KEY, next);
  return next;
}

// Lazy-require pra não criar dependência circular no boot (wa precisa de auth, etc)
function getWa() {
  return require("../whatsapp");
}

async function send(text) {
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.userId || !cfg.numberId || !cfg.groupJid) return;
  try {
    await getWa().sendText(String(cfg.userId), String(cfg.numberId), cfg.groupJid, text);
  } catch (err) {
    console.error("[admin-notifier] falha ao enviar mensagem:", err.message);
  }
}

function formatDuration(ms) {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function notifyScrapingResult(status) {
  const cfg = readConfig();
  if (!cfg.events.scraping) return;

  const r = status.lastResult;
  const hasError = !!status.lastError;
  const lines = [];

  if (hasError) {
    lines.push("*[Nimbus] ⚠️ Scraping com Erro*");
  } else {
    lines.push("*[Nimbus] ✅ Scraping Concluído*");
  }

  lines.push(`📅 ${formatDate(status.lastRun)}`);
  lines.push(`⏱ Duração: ${formatDuration(status.lastDuration)}`);

  if (r) {
    lines.push(`📦 +${r.inserted} novos · ${r.updated} atualizados · ${r.pruned || 0} removidos`);
    lines.push(`🗄 Total no catálogo: ${r.total} produtos`);

    if (r.perCategory && Object.keys(r.perCategory).length > 0) {
      lines.push("");
      lines.push("*Por categoria:*");
      for (const [tag, info] of Object.entries(r.perCategory)) {
        if (info.ok) {
          lines.push(`• ${tag}: +${info.inserted} novos ✅`);
        } else {
          lines.push(`• ${tag}: ❌ ${info.error || "erro"}`);
        }
      }
    }
  }

  if (hasError) {
    lines.push("");
    lines.push(`Erro: ${status.lastError}`);
  }

  await send(lines.join("\n"));
}

async function notifyError(context, err) {
  const cfg = readConfig();
  if (!cfg.events.errors) return;

  const lines = [
    "*[Nimbus] 🚨 Erro Crítico*",
    `📅 ${formatDate(new Date().toISOString())}`,
    `Contexto: ${context}`,
    `Erro: ${err?.message || String(err)}`,
  ];

  await send(lines.join("\n"));
}

async function notifySystemOnline() {
  const cfg = readConfig();
  if (!cfg.events.systemOnline) return;

  const lines = [
    "*[Nimbus] ✅ Sistema Online*",
    `📅 ${formatDate(new Date().toISOString())}`,
    "Backend inicializado com sucesso.",
  ];

  await send(lines.join("\n"));
}

async function sendTest() {
  const cfg = readConfig();
  if (!cfg.userId || !cfg.numberId || !cfg.groupJid) {
    throw new Error("Configure o número e o grupo antes de testar.");
  }

  const lines = [
    "*[Nimbus] 🔔 Teste de Notificação*",
    `📅 ${formatDate(new Date().toISOString())}`,
    "As notificações do sistema estão configuradas corretamente.",
  ];

  // Força envio mesmo com enabled=false para testar a config
  const text = lines.join("\n");
  try {
    await getWa().sendText(String(cfg.userId), String(cfg.numberId), cfg.groupJid, text);
  } catch (err) {
    throw new Error(`Falha ao enviar: ${err.message}`);
  }
}

module.exports = { readConfig, writeConfig, notifyScrapingResult, notifyError, notifySystemOnline, sendTest };
