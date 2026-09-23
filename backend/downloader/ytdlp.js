// Wrapper do yt-dlp: listar vídeos de um perfil e baixar um vídeo com progresso.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");

const BIN = path.join(__dirname, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
// No Windows o yt-dlp escreve no stdout em cp1252: título com emoji virava "?"
// e o caminho impresso não batia com o arquivo real.
const SPAWN_OPTS = { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } };

// O downloader divide a máquina com o scraping, o Puppeteer e o Baileys. Baixar
// vídeo é I/O, mas o merge de faixas que o yt-dlp faz no fim chama ffmpeg e
// queima CPU — com `nice` o resto do sistema continua ganhando a disputa.
// Só em Unix: no Windows não existe, e aí o spawn é do binário direto.
const NICE = process.platform === "win32" ? null : "nice";
const niceArgs = (bin, args) => (NICE ? [NICE, ["-n", "10", bin, ...args]] : [bin, args]);

function ensureBinary() {
  if (!fs.existsSync(BIN)) {
    throw new Error("yt-dlp não encontrado. Rode `npm run setup:ytdlp` na pasta backend.");
  }
}

// Roda o yt-dlp e devolve stdout inteiro. Rejeita com a última linha de erro
// do stderr, que é onde o yt-dlp explica o que deu errado.
// 170s e não 180: o nginx corta em 180s (location /api/admin/downloader/) e o
// front espera 190s. Perder a corrida de propósito faz quem responde ser este
// erro, legível, em vez de um 504 genérico.
function run(args, { timeoutMs = 170000 } = {}) {
  ensureBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(...niceArgs(BIN, args), SPAWN_OPTS);
    child.stdout.setEncoding("utf8");
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      reject(new Error(lastError(err) || `yt-dlp saiu com código ${code}`));
    });
  });
}

function lastError(stderr) {
  const lines = stderr.split(/\r?\n/).filter(Boolean);
  const errLine = [...lines].reverse().find((l) => l.startsWith("ERROR"));
  return (errLine || lines[lines.length - 1] || "").replace(/^ERROR:\s*/, "");
}

function detectPlatform(url) {
  if (/(^|\.)tiktok\.com/i.test(url)) return "tiktok";
  if (/(^|\.)(youtube\.com|youtu\.be)/i.test(url)) return "youtube";
  return "other";
}

// Perfil do YouTube sem aba (youtube.com/@canal) lista as abas, não os vídeos.
// `tab` escolhe entre videos e shorts.
function normalizeUrl(raw, tab = "videos") {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const u = new URL(url);
  if (detectPlatform(url) === "youtube") {
    const m = u.pathname.match(/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/?$/);
    if (m) u.pathname = `/${m[1]}/${tab}`;
  }
  return u.toString();
}

function pickThumb(entry, platform) {
  const thumbs = entry.thumbnails || [];
  // YouTube traz várias; a mqdefault (320x180) é leve e sempre existe.
  if (platform === "youtube" && entry.id) return `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`;
  if (entry.thumbnail) return entry.thumbnail;
  return thumbs.length ? thumbs[thumbs.length - 1].url : null;
}

async function listVideos(rawUrl, { limit = 50, tab = "videos" } = {}) {
  const url = normalizeUrl(rawUrl, tab);
  const platform = detectPlatform(url);
  const args = ["--flat-playlist", "-J", "--no-warnings"];
  if (limit > 0) args.push("--playlist-end", String(limit));
  args.push(url);

  const data = JSON.parse(await run(args));
  const entries = data.entries || [data];
  const videos = entries
    .filter((e) => e && e.id && e._type !== "playlist")
    .map((e) => ({
      id: e.id,
      title: e.title || e.description || e.id,
      url: e.url && /^https?:/.test(e.url) ? e.url : (e.webpage_url || buildUrl(platform, e, data)),
      thumbnail: pickThumb(e, platform),
      duration: e.duration || null,
      views: e.view_count ?? null,
      uploadDate: e.upload_date || (e.timestamp ? new Date(e.timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, "") : null),
    }));

  return {
    platform,
    url,
    channel: data.channel || data.uploader || data.title || null,
    videos,
  };
}

function buildUrl(platform, e, data) {
  if (platform === "youtube") return `https://www.youtube.com/watch?v=${e.id}`;
  if (platform === "tiktok") return `https://www.tiktok.com/@${data.uploader || "_"}/video/${e.id}`;
  return e.url;
}

// Baixa um vídeo para `dir`. onProgress(percent) a cada linha de progresso.
// Resolve com o caminho do arquivo final.
function downloadVideo(video, dir, onProgress) {
  ensureBinary();
  return new Promise((resolve, reject) => {
    const args = [
      // H.264 + AAC na frente: toca em qualquer player (AV1/VP9 não abrem em
      // todo lugar). Sem H.264 disponível, cai para o melhor que houver.
      "-f", "bv*+ba/b",
      "-S", "vcodec:h264,res,acodec:m4a",
      "--merge-output-format", "mp4",
      "--ffmpeg-location", ffmpegPath,
      "--no-playlist", "--no-warnings", "--newline",
      "--progress-template", "download:PROG %(progress._percent_str)s",
      "--print", "after_move:FILE %(filepath)s",
      "-o", path.join(dir, "%(title).80B [%(id)s].%(ext)s"),
      video.url,
    ];
    const child = spawn(...niceArgs(BIN, args), SPAWN_OPTS);
    child.stdout.setEncoding("utf8");
    let file = null;
    let err = "";
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const p = line.match(/^PROG\s+([\d.]+)%/);
        if (p) onProgress?.(parseFloat(p[1]));
        const f = line.match(/^FILE (.+)$/);
        if (f) file = f[1].trim();
      }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      const f = buf.match(/^FILE (.+)$/);
      if (f) file = f[1].trim();
      if (code === 0) {
        if (file && fs.existsSync(file)) return resolve(file);
        const found = findById(dir, video.id);
        if (found) return resolve(found);
      }
      reject(new Error(lastError(err) || `yt-dlp saiu com código ${code}`));
    });
  });
}

// Garantia: o nome do arquivo sempre termina em "[<id>].<ext>".
function findById(dir, id) {
  const name = fs.readdirSync(dir).find((f) => f.includes(`[${id}].`) && !/\.(part|ytdl|temp)$/.test(f));
  return name ? path.join(dir, name) : null;
}

function version() {
  return run(["--version"], { timeoutMs: 15000 }).then((v) => v.trim());
}

// O `-U` só atualiza um binário que já existe. Sem esse fallback, um servidor
// onde o setup não rodou (GitHub fora do ar no deploy) ficaria sem saída: a
// tela oferece "Atualizar yt-dlp" e o botão sempre falharia.
async function update() {
  if (!fs.existsSync(BIN)) {
    await require("../scripts/setup-ytdlp").download();
    return "yt-dlp instalado.";
  }
  return run(["-U"], { timeoutMs: 120000 });
}

module.exports = { listVideos, downloadVideo, version, update, detectPlatform };
