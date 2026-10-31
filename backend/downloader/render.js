// Queima o overlay no vídeo: um único passe de ffmpeg com o PNG que o navegador
// desenhou. Binário vem do ffmpeg-static, o mesmo que o yt-dlp já usa.
//
// O PNG é opaco fora da área do vídeo (é ele que pinta as barras) e transparente
// em cima dela. No "cover" o vídeo enche esse buraco e a cor do `pad` é
// irrelevante; no "contain" a sobra ao lado do vídeo aparece pelo buraco, então
// ela é pintada com a cor das barras — é o que a prévia mostra.
const { spawn } = require("child_process");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");

const CANVAS = { vertical: [1080, 1920], horizontal: [1920, 1080] };
// Lado ímpar faz o libx264 recusar yuv420p.
const par = (n) => Math.max(2, Math.round(n / 2) * 2);
// Offset também tem que ser par (ímpar desloca o croma), mas pode ser zero: com
// o `par` o "Tela cheia" saía em top=2, com 2px de barra no alto.
const even = (n) => Math.round(n / 2) * 2;

// Retângulo do vídeo dentro do quadro. Template antigo não tem left/width e sai
// na largura toda, como sempre saiu.
function geometry(template) {
  const [W, H] = CANVAS[template?.format === "horizontal" ? "horizontal" : "vertical"];
  const v = template?.video;
  const top = even(Math.min(Math.max(0, Number(v?.top) || 0), H - 2));
  const height = par(Math.min(Math.max(2, Number(v?.height) || H), H - top));
  const left = even(Math.min(Math.max(0, Number(v?.left) || 0), W - 2));
  const width = par(Math.min(Math.max(2, Number(v?.width) || W), W - left));
  // A cor vem do body do POST /jobs e vai parar dentro do filtergraph: só passa
  // #rrggbb, qualquer outra coisa vira preto.
  const bg = String(v?.background || "");
  const background = /^#[0-9a-f]{6}$/i.test(bg) ? `0x${bg.slice(1)}` : "black";
  return { W, H, top, height, left, width, fit: v?.fit === "contain" ? "contain" : "cover", background };
}

// `outro` ({ input, hasAudio }): a tela final, um PNG que vira alguns segundos
// de vídeo depois do fim. `input` é o índice da entrada do PNG; com áudio, o
// silêncio dessa parte é a entrada seguinte.
function filtergraph({ W, H, top, height, left = 0, width = W, fit, background = "black" }, fades = [], outro = null) {
  // cover preenche o retângulo e corta a sobra; contain mostra o vídeo inteiro
  // e deixa sobra. O trunc(../4)*2 mantém o offset par — offset ímpar desloca o
  // croma meio pixel em yuv420p.
  const base = fit === "contain"
    ? `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,`
      + `pad=${W}:${H}:${left}+trunc((${width}-iw)/4)*2:${top}+trunc((${height}-ih)/4)*2:color=${background}[base]`
    : `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,`
      + `crop=${width}:${height},setsar=1,pad=${W}:${H}:${left}:${top}:color=black[base]`;

  // yuv444 na composição mantém o croma cheio (texto branco fino não ganha
  // franja) e só no fim cai para yuv420p, que é o que todo player aceita.
  const parts = [base, `[1:v]scale=${W}:${H}:flags=lanczos[ovl]`];
  // Com tela final, o vídeo composto ainda vai ser emendado: sai como [main].
  const out = outro ? "[main]" : "[v]";
  if (!fades.length) {
    parts.push(`[base][ovl]overlay=0:0:format=yuv444:eof_action=repeat,format=yuv420p${out}`);
    return withOutro(parts, outro, W, H).join(";");
  }

  // Camadas que somem: cada fade é um PNG do quadro inteiro de antes do sumiço,
  // empilhado por cima do overlay fixo. O loop repete o frame já decodificado
  // (o -loop 1 decodificaria o PNG de novo a cada frame), o trim encerra o
  // stream quando o fade acaba e o eof_action=pass deixa o resto do vídeo sem
  // composição nenhuma. O trim nunca passa do fim do vídeo: o overlay estica a
  // saída, congelando o último frame, enquanto a segunda entrada tiver frames.
  parts.push("[base][ovl]overlay=0:0:format=yuv444:eof_action=repeat[s0]");
  fades.forEach(({ at, fade, end }, k) => {
    const sumir = fade > 0 ? `,fade=t=out:st=${num(at)}:d=${num(fade)}:alpha=1` : "";
    parts.push(
      `[${k + 2}:v]scale=${W}:${H}:flags=lanczos,format=rgba,loop=loop=-1:size=1:start=0,trim=end=${num(end)}${sumir}[f${k}]`,
      `[s${k}][f${k}]overlay=0:0:format=yuv444:eof_action=pass${k === fades.length - 1 ? `,format=yuv420p${out}` : `[s${k + 1}]`}`,
    );
  });
  return withOutro(parts, outro, W, H).join(";");
}

// Emenda a tela final depois do vídeo. O concat exige os dois pedaços com o
// mesmo tamanho, SAR e formato — e, com áudio, a mesma taxa e layout nos dois,
// daí o aformat igual no áudio do vídeo e no silêncio.
const AUDIO_FMT = "aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
function withOutro(parts, outro, W, H) {
  if (!outro) return parts;
  parts.push(`[${outro.input}:v]scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p[end]`);
  if (!outro.hasAudio) {
    parts.push("[main][end]concat=n=2:v=1:a=0[v]");
    return parts;
  }
  parts.push(
    `[0:a]${AUDIO_FMT}[a0]`,
    `[${outro.input + 1}:a]${AUDIO_FMT}[a1]`,
    "[main][a0][end][a1]concat=n=2:v=1:a=1[v][a]",
  );
  return parts;
}

// Os tempos entram no filtergraph como texto: número com 3 casas e nada mais.
const num = (n) => String(Number((Number(n) || 0).toFixed(3)));

// Quando cada fade termina, limitado à duração real do arquivo. Fade que nem
// começa antes do fim também fica: é ele que mostra a camada até o último frame.
function fadeTimes(fades, total) {
  return (fades || [])
    .map(({ file, at, fade }) => {
      const end = total > 0 ? Math.min(at + fade, total) : at + fade;
      return { file, at, fade, end };
    })
    .filter((f) => f.end > 0.05);
}

// Duração, fps e se há áudio no arquivo baixado, lidos do cabeçalho que o
// ffmpeg imprime (não há ffprobe no ffmpeg-static). A duração da listagem não
// serve aqui: vem arredondada, ou nula no TikTok.
function parseProbe(text) {
  const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const f = text.match(/Stream #[^\n]*Video:[^\n]*?(\d+(?:\.\d+)?) fps/);
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    fps: f && Number(f[1]) > 0 && Number(f[1]) <= 120 ? Number(f[1]) : 30,
    hasAudio: /Stream #[^\n]*Audio:/.test(text),
  };
}

function probe(input) {
  return new Promise((resolve) => {
    let err = "";
    const child = spawn(ffmpegPath, ["-hide_banner", "-nostdin", "-i", input], { windowsHide: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(parseProbe(err)));
  });
}

function outputPath(input) {
  const ext = path.extname(input) || ".mp4";
  return path.join(path.dirname(input), `${path.basename(input, ext)} (template)${ext}`);
}

function lastLine(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines[lines.length - 1] || "";
}

function run({ input, overlay, fades = [], outro = null, geo, output, duration, audio, onProgress }) {
  // A tela final entra depois dos fades: PNG repetido pelo tempo dela e, se o
  // vídeo tem áudio, silêncio do mesmo tamanho para o concat ter o que emendar.
  const end = outro && { input: 2 + fades.length, hasAudio: outro.hasAudio };
  const outroArgs = outro
    ? [
      "-loop", "1", "-framerate", num(outro.fps), "-t", num(outro.seconds), "-i", outro.file,
      ...(outro.hasAudio ? ["-f", "lavfi", "-t", num(outro.seconds), "-i", "anullsrc=r=48000:cl=stereo"] : []),
    ]
    : [];
  const args = [
    // -nostdin: sem isso o ffmpeg disputa a entrada do processo pai.
    "-hide_banner", "-nostdin", "-y",
    "-i", input,
    // Sem -loop: o PNG dá EOF no primeiro frame e o eof_action=repeat do overlay
    // segura esse frame até o vídeo acabar. Com -loop a saída seria infinita.
    "-i", overlay,
    ...fades.flatMap((f) => ["-i", f.file]),
    ...outroArgs,
    "-filter_complex", filtergraph(geo, fades, end),
    "-map", "[v]",
    // O "?" faz vídeo sem trilha de áudio não derrubar o comando. Com tela
    // final o áudio já sai emendado do filtergraph.
    ...(!outro ? ["-map", "0:a?"] : outro.hasAudio ? ["-map", "[a]"] : []),
    // -threads 2: o libx264 pega todos os núcleos por padrão e, num VPS pequeno,
    // deixa o scraping e o Baileys sem CPU enquanto o lote renderiza. Dois
    // threads mantêm o encode rápido o suficiente sem tomar a máquina.
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", "2",
    ...audio,
    // Repostar sem as tags de encoder/URL que o YouTube carimba no arquivo.
    "-map_metadata", "-1",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    output,
  ];

  return new Promise((resolve, reject) => {
    // `nice` pelo mesmo motivo do -threads: o encode é a coisa mais pesada que
    // o backend faz, e não pode atrapalhar quem está mandando mensagem.
    const child = process.platform === "win32"
      ? spawn(ffmpegPath, args, { windowsHide: true })
      : spawn("nice", ["-n", "10", ffmpegPath, ...args], { windowsHide: true });
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
// `outro` ({ file, seconds }) é a tela final, emendada depois do vídeo.
async function renderOverlay({ input, overlay, fades, outro, template, duration, onProgress }) {
  const geo = geometry(template);
  let total = Number(duration) || 0;
  const info = fades?.length || outro ? await probe(input) : null;
  total = info?.duration || total;
  // Sem o cabeçalho, supõe que tem áudio: se não tiver, o ffmpeg falha e o
  // vídeo sai cru com o aviso, em vez de sair mudo sem ninguém saber.
  const end = outro && { ...outro, fps: info?.fps || 30, hasAudio: info ? info.hasAudio : true };
  const base = {
    input, overlay, fades: fadeTimes(fades, total), outro: end, geo, output: outputPath(input),
    duration: total && end ? total + end.seconds : total, onProgress,
  };
  // Emendar exige recodificar o áudio: o "copy" nem é tentado.
  if (end) return run({ ...base, audio: ["-c:a", "aac", "-b:a", "192k"] });
  try {
    return await run({ ...base, audio: ["-c:a", "copy"] });
  } catch {
    // Copiar o áudio falha quando o codec não cabe em mp4 (opus vindo de webm,
    // por exemplo). Recodificar resolve e custa pouco.
    return await run({ ...base, audio: ["-c:a", "aac", "-b:a", "192k"] });
  }
}

module.exports = { renderOverlay, geometry, filtergraph, fadeTimes, outputPath, parseProbe };
