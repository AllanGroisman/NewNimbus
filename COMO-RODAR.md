# Como rodar o Nimbus

## Pré-requisitos

- Node.js (v18+)
- npm
- ngrok (opcional, para acesso externo)

### Instalar dependências (só na primeira vez)

```bash
# Frontend
cd frontend
npm install

# Backend
cd ../backend
npm install

# ngrok (opcional)
npm install -g ngrok
ngrok config add-authtoken SEU_TOKEN
# Pegue o token em: https://dashboard.ngrok.com → Your Authtoken
```

---

## Rodando o projeto

Abra **3 terminais** separados:

### Terminal 1 — Backend (API + Scraper)

```bash
cd backend
node server.js
```

Deve aparecer:
```
Nimbus Backend rodando em http://localhost:3001
```

### Terminal 2 — Frontend (Vite)

```bash
cd frontend
npx vite --host
```

Deve aparecer:
```
Local:   http://localhost:5173/
Network: http://192.168.x.x:5173/
```

### Terminal 3 — ngrok (acesso externo, opcional)

```bash
ngrok http 5173
```

Vai gerar uma URL pública tipo:
```
https://xxxx-xxxx.ngrok-free.dev
```

Qualquer pessoa pode acessar o Nimbus por essa URL.

> **Obs:** Na primeira vez que alguém acessar, o ngrok mostra uma página de aviso — basta clicar em "Visit Site".

---

## Notas

- Os 3 terminais precisam ficar abertos enquanto o sistema estiver rodando
- A URL do ngrok muda toda vez que reiniciar (plano grátis)
- O scraping (Puppeteer) roda no seu PC — ele precisa estar ligado
- O frontend acessa o backend via proxy (`/api` → `localhost:3001`), então não precisa expor a porta 3001
