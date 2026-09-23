// Vigia do backup. O upload remoto já falhou por semanas sem ninguém notar
// (cron com node antigo) — este módulo checa de hora em hora a idade do último
// dump local e do último snapshot no B2 e alerta o admin pelo WhatsApp quando
// o backup para de rodar. O resultado fica cacheado pra o /healthz expor sem
// custo de request ao B2.

const backupApi = require("./api");
const adminNotifier = require("../notifications/admin-notifier");
const logger = require("../infra/logger");

const CHECK_MS = 60 * 60 * 1000;
const FIRST_CHECK_MS = 5 * 60 * 1000;
const ALERT_THROTTLE_MS = 12 * 60 * 60 * 1000;

// Number(env) || default engoliria 0 — e 0 é útil pra testar o alerta.
function envHours(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}
const LOCAL_MAX_H = envHours("BACKUP_ALERT_LOCAL_MAX_H", 3);
const REMOTE_MAX_H = envHours("BACKUP_ALERT_REMOTE_MAX_H", 6);
// Idade não pega dump que roda mas sai vazio/encolhido. Alerta quando o último
// fica abaixo desta fração da mediana dos anteriores.
const SIZE_MIN_RATIO = 0.5;
const SIZE_BASELINE_N = 5;

let timers = [];
const lastAlertAt = { local: 0, remote: 0, size: 0 };
const last = {
  lastLocalAgeMin: null,
  lastRemoteAgeMin: null,
  lastLocalSizeMB: null,
  checkedAt: null,
  error: null,
};

function ageMin(iso) {
  const t = new Date(iso || 0).getTime();
  return Number.isFinite(t) && t > 0 ? Math.max(0, Math.round((Date.now() - t) / 60000)) : null;
}

async function alertIfStale(kind, age, maxH, label) {
  if (age == null || age <= maxH * 60) return;
  if (Date.now() - lastAlertAt[kind] < ALERT_THROTTLE_MS) return;
  lastAlertAt[kind] = Date.now();
  const msg = `último backup ${label} tem ${(age / 60).toFixed(1)}h (limite ${maxH}h) — verifique o cron e o backup-all.sh`;
  logger.error({ ageMin: age, maxH }, `[backup-monitor] ${msg}`);
  try {
    await adminNotifier.notifyError("Backup", new Error(msg));
  } catch (err) {
    logger.warn({ err: err.message }, "[backup-monitor] falha ao notificar admin");
  }
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// `local` vem do listLocal(): mais novo primeiro.
async function alertIfShrunk(local) {
  const base = local.slice(1, 1 + SIZE_BASELINE_N).map(d => d.size);
  if (base.length < 2) return;
  const ref = median(base);
  if (!ref || local[0].size >= ref * SIZE_MIN_RATIO) return;
  if (Date.now() - lastAlertAt.size < ALERT_THROTTLE_MS) return;
  lastAlertAt.size = Date.now();
  const mb = n => (n / 1024 / 1024).toFixed(1);
  const msg = `último backup local (${local[0].name}) tem ${mb(local[0].size)}MB, abaixo de ${SIZE_MIN_RATIO * 100}% da mediana recente (${mb(ref)}MB) — confira se o dump está completo`;
  logger.error({ size: local[0].size, ref }, `[backup-monitor] ${msg}`);
  try {
    await adminNotifier.notifyError("Backup", new Error(msg));
  } catch (err) {
    logger.warn({ err: err.message }, "[backup-monitor] falha ao notificar admin");
  }
}

async function check() {
  try {
    const local = await backupApi.listLocal();
    last.lastLocalAgeMin = local.length ? ageMin(local[0].createdAt) : null;
    last.lastLocalSizeMB = local.length ? Number((local[0].size / 1024 / 1024).toFixed(2)) : null;
    await alertIfStale("local", last.lastLocalAgeMin, LOCAL_MAX_H, "local");
    await alertIfShrunk(local);

    if (backupApi.B2_OK) {
      const remote = await backupApi.listRemote();
      const newest = remote.ok && remote.items.length ? remote.items[0] : null;
      last.lastRemoteAgeMin = newest ? ageMin(newest.createdAt) : null;
      await alertIfStale("remote", last.lastRemoteAgeMin, REMOTE_MAX_H, "remoto (B2)");
    }
    last.checkedAt = new Date().toISOString();
    last.error = null;
  } catch (err) {
    last.error = err.message;
    logger.warn({ err: err.message }, "[backup-monitor] checagem falhou");
  }
}

function start() {
  if (process.env.NODE_ENV === "test") return;
  if (timers.length) return;
  const first = setTimeout(() => { check(); }, FIRST_CHECK_MS);
  const loop = setInterval(() => { check(); }, CHECK_MS);
  for (const t of [first, loop]) t.unref?.();
  timers = [first, loop];
}

function stop() {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

function status() {
  return { ...last, alertLocalMaxH: LOCAL_MAX_H, alertRemoteMaxH: REMOTE_MAX_H };
}

module.exports = { start, stop, status, check };
