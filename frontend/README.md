# frontend/

SPA em **React 19 + Vite** que o usuário enxerga no navegador. Não tem TypeScript, não tem framework de CSS — estilos vão inline ou via `App.css` / `index.css` com CSS variables pra tema claro/escuro.

## Como rodar em dev

```bash
cd frontend
npm install      # primeira vez
npx vite --host  # sobe na porta 5173 com hot reload
```

O Vite faz proxy de `/api/*` pra `localhost:3001` (o backend), então você não precisa configurar URL absoluta nem CORS.

## Scripts úteis

```bash
npm run lint    # checa o código com ESLint
npm run build   # build de produção pra dist/
```

## Estrutura

- **`src/`** — todo o código React.
- **`src/main.jsx`** — ponto de entrada. Monta o `<App />` na div `#root`.
- **`src/App.jsx`** — componente raiz. Faz login/logout, carrega estado do usuário, faz polling do scheduler.
- **`src/App.css`** / **`src/index.css`** — estilos globais (tema claro/escuro via CSS variables).
- **`src/components/`** — componentes reutilizáveis (sidebar, QR code, dashboard de grupo).
- **`src/pages/`** — uma página por rota (Dashboard, Settings, WhatsApp, Login, etc).
- **`src/data/`** — helpers de dados: constantes (categorias, fontes), helper de API (`fetch` + token), starter state.
- **`src/__tests__/`** — testes Vitest + RTL (`api.test.js`, `constants.test.js`, `Subscription.test.jsx`, `GroupDashboard.test.jsx`).
- **`public/`** — arquivos servidos crus na raiz (favicon, etc).

## Token JWT

O token volta do `/api/auth/login` e é guardado em `localStorage["nimbus.token"]`. O helper `http()` em `src/data/api.js` injeta `Authorization: Bearer <token>` em todo request e trata 401 (dispara o evento `nimbus:unauthorized` que faz o `App.jsx` voltar pro login).
