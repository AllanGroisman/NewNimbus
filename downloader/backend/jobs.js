// Fila de downloads em memória. Cada job é um lote de vídeos baixados para
// tmp/<jobId>/, com no máximo CONCURRENCY downloads simultâneos no total.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { downloadVideo } = require("./ytdlp");

const TMP = path.join(__dirname, "tmp");
const CONCURRENCY = 2;
const TTL_MS = 60 * 60 * 1000;

const jobs = new Map();
const queue = [];
let running = 0;

function resetTmp() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}

function createJob(videos) {
  const id = crypto.randomUUID();
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    id,
    dir,
    createdAt: Date.now(),
    items: videos.map((v) => ({
      id: String(v.id),
      url: v.url,
      title: v.title || v.id,
      status: "queued",
      percent: 0,
      file: null,
      error: null,
    })),
  };
  jobs.set(id, job);
  for (const item of job.items) queue.push({ job, item });
  pump();
  return job;
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const { job, item } = queue.shift();
    running++;
    item.status = "downloading";
    downloadVideo(item, job.dir, (p) => { item.percent = p; })
      .then((file) => {
        item.status = "done";
        item.percent = 100;
        item.file = file;
      })
      .catch((err) => {
        item.status = "error";
        item.error = err.message;
      })
      .finally(() => {
        running--;
        if (isFinished(job)) scheduleCleanup(job);
        pump();
      });
  }
}

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
    items: job.items.map(({ id, title, status, percent, error, file }) => ({
      id, title, status, percent, error,
      filename: file ? path.basename(file) : null,
    })),
  };
}

module.exports = { resetTmp, createJob, getJob, serialize };
