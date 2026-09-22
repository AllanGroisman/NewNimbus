// Nimbus Downloader — API local (só escuta em 127.0.0.1).
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const ytdlp = require("./ytdlp");
const jobs = require("./jobs");
const tiktokProduct = require("./tiktokProduct");
const youtubeProduct = require("./youtubeProduct");

const PORT = Number(process.env.PORT) || 3002;
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_req, res) => {
  try {
    res.json({ ok: true, ytdlp: await ytdlp.version() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/list", async (req, res) => {
  const { url, limit = 50, tab = "videos" } = req.body || {};
  if (!url || typeof url !== "string") return res.status(400).json({ error: "Informe a URL do perfil." });
  try {
    res.json(await ytdlp.listVideos(url, {
      limit: Math.max(0, Number(limit) || 0),
      tab: tab === "shorts" ? "shorts" : "videos",
    }));
  } catch (err) {
    res.status(502).json({ error: `Não foi possível listar os vídeos: ${err.message}` });
  }
});

app.post("/api/products", async (req, res) => {
  const url = req.body?.url;
  const source = typeof url === "string" && [tiktokProduct, youtubeProduct].find((m) => m.isVideoUrl(url));
  if (!source) return res.status(400).json({ error: "URL de vídeo inválida." });
  try {
    res.json({ products: await source.getProducts(url) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/jobs", (req, res) => {
  const videos = (req.body?.videos || []).filter((v) => v && v.id && typeof v.url === "string" && /^https?:\/\//.test(v.url));
  if (!videos.length) return res.status(400).json({ error: "Nenhum vídeo selecionado." });
  const job = jobs.createJob(videos);
  res.json({ jobId: job.id });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Download não encontrado (pode ter expirado)." });
  res.json(jobs.serialize(job));
});

app.get("/api/jobs/:id/file/:videoId", (req, res) => {
  const job = jobs.getJob(req.params.id);
  const item = job?.items.find((i) => i.id === req.params.videoId);
  if (!item?.file || !fs.existsSync(item.file)) return res.status(404).json({ error: "Arquivo não disponível." });
  res.download(item.file, path.basename(item.file));
});

app.get("/api/jobs/:id/zip", (req, res) => {
  const job = jobs.getJob(req.params.id);
  const done = (job?.items || []).filter((i) => i.file && fs.existsSync(i.file));
  if (!done.length) return res.status(404).json({ error: "Nenhum arquivo pronto." });
  res.attachment(`videos-${new Date().toISOString().slice(0, 10)}.zip`);
  // Vídeo já é comprimido: store (level 0) evita gastar CPU à toa.
  const zip = archiver("zip", { zlib: { level: 0 } });
  zip.on("error", (err) => res.destroy(err));
  zip.pipe(res);
  for (const i of done) zip.file(i.file, { name: path.basename(i.file) });
  zip.finalize();
});

app.post("/api/update-ytdlp", async (_req, res) => {
  try {
    const out = await ytdlp.update();
    res.json({ ok: true, output: out.trim(), version: await ytdlp.version() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

jobs.resetTmp();
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Nimbus Downloader API em http://127.0.0.1:${PORT}`);
});
