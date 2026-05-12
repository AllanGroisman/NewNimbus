# components/

Componentes React **reutilizáveis** — usados em mais de uma página ou que dá pra extrair pra deixar a página mais limpa.

## Arquivos

- **`Sidebar.jsx`** — menu lateral do app. Lista as páginas (Dashboard, Settings, WhatsApp, etc) e marca a ativa.
- **`GroupDashboard.jsx`** — o card grandão de cada grupo no Dashboard. Mostra fila, próximo envio, métricas, controles (refill agora, enviar agora, pausar).
- **`WhatsappQR.jsx`** — exibe o QR code real (data URL) vindo do backend pra parear um número novo no WhatsApp.
- **`FakeQRCode.jsx`** — componente decorativo (QR fake) usado em telas de demo / placeholder.
- **`ui/`** — sub-pasta com componentes visuais bem genéricos (botões, inputs, modal, etc).
