// Admin › Downloader — baixa vídeos de perfis do YouTube/TikTok com o yt-dlp e,
// opcionalmente, queima um template por cima com o ffmpeg.
//
// Veio do app standalone que morava em downloader/. Um Router próprio em vez de
// mais onze app.get/post no server.js: o módulo inteiro é admin-only e tem
// prefixo único, então o requireAuth mora aqui e o server.js ganha uma linha.
//
// ATENÇÃO à ordem das rotas neste arquivo: as duas que entregam arquivo ficam
// ANTES do router.use(requireAuth) de propósito. Elas são abertas por <a href>,
// que não manda header nenhum, então quem autoriza ali é a chave do job (ver o
// comentário da `key` em jobs.js). Todo o resto é autenticado.
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const auth = require("../auth");
const httpErrors = require("../infra/httpErrors");
const disk = require("../infra/disk");
const ytdlp = require("./ytdlp");
const jobs = require("./jobs");
const tiktokProduct = require("./tiktokProduct");
const youtubeProduct = require("./youtubeProduct");
const templates = require("./templates");

const router = express.Router();

// Teto por lote. É o que mantém o corpo do POST /jobs dentro dos 64mb: cada
// vídeo pode mandar o seu PNG de overlay quando o texto usa {titulo}.
const MAX_VIDEOS = 30;
// Vídeo baixado + a cópia com template ocupam bastante; abaixo disto o lote
// falharia no meio, com metade dos arquivos no disco.
const MIN_FREE_BYTES = 5e9;

// ── Rotas de arquivo (sem requireAuth — autorizadas pela chave do job) ──────

// Sempre 404, nunca 403: um 403 confirmaria que o job existe.
function jobByKey(req, res) {
  const job = jobs.getJob(req.params.id);
  const given = Buffer.from(String(req.query.k || ""));
  const expected = job ? Buffer.from(job.key) : null;
  // timingSafeEqual lança se os tamanhos diferem — conferir antes.
  const ok = expected && given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) {
    res.status(404).json({ error: "Arquivo não disponível." });
    return null;
  }
  return job;
}

// ?raw=1 entrega o vídeo sem template: o original fica em disco de graça, então
// dá para decidir depois de ver o resultado.
const pick = (item, raw) => (raw ? item?.raw : item?.file);

router.get("/jobs/:id/file/:videoId", (req, res) => {
  const job = jobByKey(req, res);
  if (!job) return;
  const item = job.items.find((i) => i.id === req.params.videoId);
  const file = pick(item, req.query.raw);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "Arquivo não disponível." });
  res.download(file, path.basename(file));
});

router.get("/jobs/:id/zip", (req, res) => {
  const job = jobByKey(req, res);
  if (!job) return;
  const done = job.items
    .map((i) => pick(i, req.query.raw))
    .filter((f) => f && fs.existsSync(f))
    .map((f) => ({ file: f }));
  if (!done.length) return res.status(404).json({ error: "Nenhum arquivo pronto." });
  res.attachment(`videos-${new Date().toISOString().slice(0, 10)}.zip`);
  // Vídeo já é comprimido: store (level 0) evita gastar CPU à toa.
  const zip = archiver("zip", { zlib: { level: 0 } });
  zip.on("error", (err) => res.destroy(err));
  zip.pipe(res);
  for (const i of done) zip.file(i.file, { name: path.basename(i.file) });
  zip.finalize();
});

// ── Daqui pra baixo, tudo exige admin ───────────────────────────────────────

router.use(auth.requireAuth, auth.requireAdmin);

router.get("/health", async (_req, res) => {
  try {
    res.json({ ok: true, ytdlp: await ytdlp.version() });
  } catch (err) {
    // 200 com ok:false: o binário faltando não é erro do servidor, é o estado
    // que a tela precisa mostrar pra oferecer o botão "Atualizar yt-dlp".
    res.json({ ok: false, error: err.message });
  }
});

router.post("/list", async (req, res) => {
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

router.post("/products", async (req, res) => {
  const url = req.body?.url;
  const source = typeof url === "string" && [tiktokProduct, youtubeProduct].find((m) => m.isVideoUrl(url));
  if (!source) return res.status(400).json({ error: "URL de vídeo inválida." });
  try {
    res.json({ products: await source.getProducts(url) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get("/templates", (_req, res) => {
  try {
    res.json({ templates: templates.list() });
  } catch (err) {
    httpErrors.serverError(res, err, { req: _req, ctx: "GET /api/admin/downloader/templates" });
  }
});

router.put("/templates/:id", (req, res) => {
  try {
    res.json(templates.save(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/templates/:id", (req, res) => {
  try {
    templates.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "DELETE /api/admin/downloader/templates/:id" });
  }
});

router.post("/jobs", async (req, res) => {
  const videos = (req.body?.videos || []).filter((v) => v && v.id && typeof v.url === "string" && /^https?:\/\//.test(v.url));
  if (!videos.length) return res.status(400).json({ error: "Nenhum vídeo selecionado." });
  if (videos.length > MAX_VIDEOS) {
    return res.status(400).json({ error: `Selecione no máximo ${MAX_VIDEOS} vídeos por lote.` });
  }
  try {
    // Checagem barata de disco antes de começar: um lote que enche o disco
    // derruba o backend inteiro, não só o download.
    if (await disk.freeBytes(jobs.TMP) < MIN_FREE_BYTES) {
      return res.status(507).json({ error: "Espaço em disco insuficiente para baixar os vídeos." });
    }
    const job = jobs.createJob(videos, {
      template: req.body?.template,
      overlay: req.body?.overlay,
      ownerId: req.user?.id ?? null,
    });
    res.json({ jobId: job.id });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "POST /api/admin/downloader/jobs" });
  }
});

router.get("/jobs/:id", (req, res) => {
  const job = jobs.getJob(req.params.id);
  // Lote de outro admin responde igual a lote inexistente.
  if (!job || (job.ownerId != null && job.ownerId !== req.user?.id)) {
    return res.status(404).json({ error: "Download não encontrado (pode ter expirado)." });
  }
  res.json(jobs.serialize(job));
});

router.post("/update-ytdlp", async (req, res) => {
  try {
    const out = await ytdlp.update();
    res.json({ ok: true, output: out.trim(), version: await ytdlp.version() });
  } catch (err) {
    res.status(502).json({ error: `Não foi possível atualizar o yt-dlp: ${err.message}` });
  }
});

module.exports = router;
