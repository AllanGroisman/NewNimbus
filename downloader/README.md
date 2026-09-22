# Nimbus Downloader

App local e independente do Nimbus (só reaproveita o visual) para baixar vídeos
de perfis do YouTube e TikTok usando o [yt-dlp](https://github.com/yt-dlp/yt-dlp).

Fluxo: colar o link do perfil → listar vídeos → selecionar → baixar (MP4, melhor qualidade).

No TikTok, cada card mostra o produto do TikTok Shop anunciado no vídeo (lido da
página do vídeo, em `backend/tiktokProduct.js`), e dá pra copiar todos os links de uma vez.

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

- `backend/` — Express 5 (CommonJS). `ytdlp.js` faz o spawn do yt-dlp, `jobs.js` a fila (2 downloads simultâneos).
- `frontend/` — Vite + React 19. `src/index.css` e `components/ui/` são cópias do Nimbus.
