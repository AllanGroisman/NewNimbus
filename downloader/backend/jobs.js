// Fila de downloads em memória. Cada job é um lote de vídeos baixados para
// tmp/<jobId>/ e, quando há template, queimados com o overlay logo em seguida.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { downloadVideo } = require("./ytdlp");
const { renderOverlay } = require("./render");

const TMP = path.join(__dirname, "tmp");
const DL_CONCURRENCY = 2;
// Render é CPU-bound (o libx264 já usa todos os núcleos): mais de um por vez
// trava a máquina sem ganhar throughput.
const RENDER_CONCURRENCY = 1;
const TTL_MS = 60 * 60 * 1000;

const jobs = new Map();
const dlQueue = [];
const rnQueue = [];
let downloading = 0;
let rendering = 0;

function resetTmp() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}

// O PNG vem como data-URL do navegador. Conferir o cabeçalho e os magic bytes
// custa duas linhas e evita gravar qualquer coisa no disco.
function savePng(dir, name, dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return file;
}

function createJob(videos, { template = null, overlay = null } = {}) {
  const id = crypto.randomUUID();
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });

  // Um PNG só para o lote inteiro, salvo quando o texto usa {titulo} — aí cada
  // vídeo manda o seu.
  const shared = overlay ? savePng(dir, "overlay.png", overlay) : null;

  const job = {
    id,
    dir,
    createdAt: Date.now(),
    template: template || null,
    items: videos.map((v, i) => ({
      id: String(v.id),
      url: v.url,
      title: v.title || v.id,
      duration: Number(v.duration) || null,
      // Índice e não id no nome: id de vídeo pode ter caractere inválido em path.
      overlay: v.overlay ? savePng(dir, `overlay-${i}.png`, v.overlay) : shared,
      status: "queued",
      percent: 0,
      file: null,
      raw: null,
      warning: null,
      error: null,
    })),
  };
  jobs.set(id, job);
  for (const item of job.items) dlQueue.push({ job, item });
  pumpDownload();
  return job;
}

function pumpDownload() {
  while (downloading < DL_CONCURRENCY && dlQueue.length) {
    const { job, item } = dlQueue.shift();
    downloading++;
    item.status = "downloading";
    downloadVideo(item, job.dir, (p) => { item.percent = p; })
      .then((file) => {
        item.raw = file;
        if (!job.template || !item.overlay) return finish(item, file);
        item.status = "queued"; // volta para a fila, agora a de render
        item.percent = 0;
        rnQueue.push({ job, item });
        pumpRender();
      })
      .catch((err) => {
        item.status = "error";
        item.error = err.message;
      })
      .finally(() => {
        downloading--;
        settle(job);
        pumpDownload();
      });
  }
}

function pumpRender() {
  while (rendering < RENDER_CONCURRENCY && rnQueue.length) {
    const { job, item } = rnQueue.shift();
    rendering++;
    item.status = "rendering";
    renderOverlay({
      input: item.raw,
      overlay: item.overlay,
      template: job.template,
      duration: item.duration,
      onProgress: (p) => { item.percent = p; },
    })
      .then((file) => finish(item, file))
      .catch((err) => {
        // O download já custou tempo: entregar o vídeo cru com um aviso é
        // melhor que jogar o lote fora porque o template falhou.
        item.warning = `Template não aplicado: ${err.message}`;
        finish(item, item.raw);
      })
      .finally(() => {
        rendering--;
        settle(job);
        pumpRender();
      });
  }
}

function finish(item, file) {
  item.file = file;
  item.status = "done";
  item.percent = 100;
}

function settle(job) {
  if (isFinished(job)) scheduleCleanup(job);
}

// "rendering" e "queued" não são terminais: a limpeza só corre depois que o
// último item saiu das duas filas.
function isFinished(job) {
  return job.items.every((i) => i.status === "done" || i.status === "error");
}

function scheduleCleanup(job) {
  setTimeout(() => {
    fs.rmSync(job.dir, { recursive: true, force: true });
    jobs.delete(job.id);
  }, TTL_MS).unref();
}

function getJob(id) {
  return jobs.get(id) || null;
}

// Visão pública: sem caminhos do disco.
function serialize(job) {
  return {
    id: job.id,
    finished: isFinished(job),
    hasTemplate: Boolean(job.template),
    items: job.items.map(({ id, title, status, percent, error, warning, file, raw }) => ({
      id, title, status, percent, error, warning,
      filename: file ? path.basename(file) : null,
      // Só oferece o original quando ele é mesmo diferente do entregue.
      raw: Boolean(raw && raw !== file),
    })),
  };
}

module.exports = { resetTmp, createJob, getJob, serialize };
