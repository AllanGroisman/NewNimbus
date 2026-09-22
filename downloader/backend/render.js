// Queima o overlay no vídeo: um único passe de ffmpeg com o PNG que o navegador
// desenhou. Binário vem do ffmpeg-static, o mesmo que o yt-dlp já usa.
//
// O PNG é opaco fora da área do vídeo (é ele que pinta as barras) e transparente
// em cima dela. Por isso a cor do `pad` aqui é irrelevante: o que o usuário viu
// na prévia é literalmente o bitmap que entra no filtro.
const { spawn } = require("child_process");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");

const CANVAS = { vertical: [1080, 1920], horizontal: [1920, 1080] };
// Lado ímpar faz o libx264 recusar yuv420p.
const par = (n) => Math.max(2, Math.round(n / 2) * 2);

function geometry(template) {
  const [W, H] = CANVAS[template?.format === "horizontal" ? "horizontal" : "vertical"];
  const top = par(Math.min(Math.max(0, Number(template?.video?.top) || 0), H - 2));
  const height = par(Math.min(Math.max(2, Number(template?.video?.height) || H), H - top));
  return { W, H, top, height, fit: template?.video?.fit === "contain" ? "contain" : "cover" };
}

function filtergraph({ W, H, top, height, fit }) {
  // cover preenche a faixa e corta a sobra; contain mostra o vídeo inteiro e
  // deixa sobra. O trunc(../4)*2 mantém o offset par — offset ímpar desloca o
  // croma meio pixel em yuv420p.
  const base = fit === "contain"
    ? `[0:v]scale=${W}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,`
      + `pad=${W}:${H}:trunc((${W}-iw)/4)*2:${top}+trunc((${height}-ih)/4)*2:color=black[base]`
    : `[0:v]scale=${W}:${height}:force_original_aspect_ratio=increase:flags=lanczos,`
      + `crop=${W}:${height},setsar=1,pad=${W}:${H}:0:${top}:color=black[base]`;

  return [
    base,
    `[1:v]scale=${W}:${H}:flags=lanczos[ovl]`,
    // yuv444 na composição mantém o croma cheio (texto branco fino não ganha
    // franja) e só no fim cai para yuv420p, que é o que todo player aceita.
    "[base][ovl]overlay=0:0:format=yuv444:eof_action=repeat,format=yuv420p[v]",
  ].join(";");
}

function outputPath(input) {
  const ext = path.extname(input) || ".mp4";
  return path.join(path.dirname(input), `${path.basename(input, ext)} (template)${ext}`);
}

function lastLine(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines[lines.length - 1] || "";
}

function run({ input, overlay, geo, output, duration, audio, onProgress }) {
  const args = [
    // -nostdin: sem isso o ffmpeg disputa a entrada do processo pai.
    "-hide_banner", "-nostdin", "-y",
    "-i", input,
    // Sem -loop: o PNG dá EOF no primeiro frame e o eof_action=repeat do overlay
    // segura esse frame até o vídeo acabar. Com -loop a saída seria infinita.
    "-i", overlay,
    "-filter_complex", filtergraph(geo),
    "-map", "[v]",
    // O "?" faz vídeo sem trilha de áudio não derrubar o comando.
    "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    ...audio,
    // Repostar sem as tags de encoder/URL que o YouTube carimba no arquivo.
    "-map_metadata", "-1",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    output,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let total = Number(duration) > 0 ? Number(duration) : 0;
    let err = "";
    let buf = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_us=(-?\d+)/);
        // Os primeiros blocos vêm com N/A ou um negativo gigante.
        if (!m || !(Number(m[1]) >= 0) || !total) continue;
        // 99 e não 100: o +faststart ainda reescreve o arquivo depois.
        onProgress?.(Math.min(99, (Number(m[1]) / 1e6 / total) * 100));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      err += d;
      // Não há ffprobe no ffmpeg-static, e a duração da listagem vem nula no
      // TikTok — a de reserva sai do cabeçalho que o próprio ffmpeg imprime.
      if (!total) {
        const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
        if (m) total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(output);
      reject(new Error(lastLine(err) || `ffmpeg saiu com código ${code}`));
    });
  });
}

// Resolve com o caminho do arquivo com o template aplicado.
async function renderOverlay({ input, overlay, template, duration, onProgress }) {
  const geo = geometry(template);
  const base = { input, overlay, geo, output: outputPath(input), duration, onProgress };
  try {
    return await run({ ...base, audio: ["-c:a", "copy"] });
  } catch {
    // Copiar o áudio falha quando o codec não cabe em mp4 (opus vindo de webm,
    // por exemplo). Recodificar resolve e custa pouco.
    return await run({ ...base, audio: ["-c:a", "aac", "-b:a", "192k"] });
  }
}

module.exports = { renderOverlay, geometry, filtergraph, outputPath };
