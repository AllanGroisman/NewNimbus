// Baixa o executável do yt-dlp (release oficial do GitHub) para backend/bin/.
// Rodar de novo sobrescreve com a versão mais recente.
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const BIN_DIR = path.join(__dirname, "..", "bin");
const FILES = {
  win32: "yt-dlp.exe",
  darwin: "yt-dlp_macos",
  linux: "yt-dlp_linux",
};

async function main() {
  const asset = FILES[process.platform] || "yt-dlp";
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  const dest = path.join(BIN_DIR, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

  fs.mkdirSync(BIN_DIR, { recursive: true });
  console.log(`Baixando ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar o yt-dlp`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  if (process.platform !== "win32") fs.chmodSync(dest, 0o755);
  console.log(`yt-dlp salvo em ${dest}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
