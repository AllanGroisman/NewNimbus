# Nimbus Downloader

App local e independente do Nimbus (só reaproveita o visual) para baixar vídeos
de perfis do YouTube e TikTok usando o [yt-dlp](https://github.com/yt-dlp/yt-dlp).

Fluxo: colar o link do perfil → listar vídeos → selecionar → baixar (MP4, melhor qualidade).

No TikTok, cada card mostra o produto do TikTok Shop anunciado no vídeo (lido da
página do vídeo, em `backend/tiktokProduct.js`), e dá pra copiar todos os links de uma vez.

## Templates

Para reaproveitar o conteúdo em vez de repostar cru, dá para queimar um template
por cima do vídeo: faixas coloridas, texto, logo e o formato "vídeo reduzido entre
barras". O seletor fica ao lado do botão Baixar — "Sem template" baixa o original,
como antes. Mesmo com template, o vídeo cru continua disponível no botão
**Original** e no **.zip sem template**.

Como funciona: o overlay é desenhado num `<canvas>` **no navegador**
(`frontend/src/overlay.js`), em 1080×1920 ou 1920×1080, e vira um PNG com o
retângulo do vídeo transparente. O backend só recebe esse PNG mais a geometria e
faz um passe de ffmpeg (`backend/render.js`). Por isso o arquivo final é idêntico
à prévia — inclusive acento e emoji colorido, que o `drawtext` do ffmpeg não
renderiza.

No texto, `{titulo}` é trocado pelo título de cada vídeo (aí o navegador gera um
PNG por vídeo em vez de um só para o lote).

Os templates ficam em `backend/data/templates.json` (fora do Git, porque o logo
vai embutido em base64). Na primeira execução são criados dois de fábrica.

## Rodar

```bash
cd downloader
npm install        # instala o concurrently
npm run setup      # instala backend+frontend e baixa o yt-dlp para backend/bin/
npm run dev        # API em 127.0.0.1:3002 + front em http://localhost:5174
```

- ffmpeg vem do pacote `ffmpeg-static` (não precisa instalar).
- Os arquivos ficam em `backend/tmp/<job>/` e são apagados 1h após o término
  (e ao reiniciar a API).
- Se o YouTube/TikTok mudar e a listagem quebrar, atualize o yt-dlp:
  `npm run setup --prefix backend` (ou `POST /api/update-ytdlp`).

## Estrutura

- `backend/` — Express 5 (CommonJS). `ytdlp.js` faz o spawn do yt-dlp, `render.js` o do ffmpeg,
  `templates.js` guarda os templates e `jobs.js` a fila (2 downloads simultâneos, 1 render por vez).
- `frontend/` — Vite + React 19. `src/overlay.js` é o pintor do overlay (a mesma função serve a
  prévia e a exportação). `src/index.css` e `components/ui/` são cópias do Nimbus.
