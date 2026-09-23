// Baixa o executável do yt-dlp (release oficial do GitHub) para
// backend/downloader/bin/. Rodar de novo sobrescreve com a versão mais recente.
//
// Fica fora do node_modules pelo mesmo motivo do Chrome do Puppeteer: é um
// binário grande, de release próprio, que o npm não versiona. Chamado pelo
// `npm run setup:ytdlp`, pelos scripts de deploy e — quando o binário nem
// existe — pelo botão "Atualizar yt-dlp" da tela do Admin.
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const BIN_DIR = path.join(__dirname, "..", "downloader", "bin");
const FILES = {
  win32: "yt-dlp.exe",
  darwin: "yt-dlp_macos",
  linux: "yt-dlp_linux",
};

// Resolve com o caminho do binário baixado.
async function download({ log = () => {} } = {}) {
  const asset = FILES[process.platform] || "yt-dlp";
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  const dest = path.join(BIN_DIR, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

  fs.mkdirSync(BIN_DIR, { recursive: true });
  log(`Baixando ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar o yt-dlp`);
  // Grava num .tmp e renomeia: se a conexão cair no meio, o binário que já
  // estava lá continua inteiro em vez de virar um arquivo truncado.
  const tmp = `${dest}.tmp`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
  log(`yt-dlp salvo em ${dest}`);
  return dest;
}

module.exports = { download, BIN_DIR };

if (require.main === module) {
  download({ log: console.log }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
