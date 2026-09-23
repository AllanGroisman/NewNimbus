// PM2 ecosystem config — produção / staging.
// Uso:
//   npm install -g pm2
//   pm2 start ecosystem.config.js              # sobe o backend
//   pm2 logs nimbus-backend                    # ver logs
//   pm2 restart nimbus-backend
//   pm2 save && pm2 startup                    # autostart no boot do SO

module.exports = {
  apps: [
    {
      name: "nimbus-backend",
      script: "./server.js",
      cwd: __dirname,
      instances: 1,            // server pode ser horizontalmente escalado em redis mode
      exec_mode: "fork",
      autorestart: true,
      watch: false,            // não auto-reload em prod
      // 1500M e não 1G por causa do Downloader: o POST de um lote com template
      // por título carrega até 64MB de PNG, que viram string + objeto parseado
      // + Buffer ao mesmo tempo. Em 1G o PM2 reiniciava justo no job que causou
      // o pico e, como a fila é em memória, o lote do usuário sumia em silêncio.
      max_memory_restart: "1500M",
      // Se o boot falha por dependência fora (Redis/Postgres), o PM2 reinicia
      // em loop. Sem espaçar as tentativas isso vira dezenas de restarts por
      // segundo enchendo o log; com backoff, ele tenta de novo cada vez mais
      // devagar (até 15s) e volta sozinho quando a dependência sobe.
      exp_backoff_restart_delay: 200,
      kill_timeout: 5000,      // dá tempo do scheduler terminar tick atual
      env: {
        NODE_ENV: "production",
        PORT: 3001,
        NIMBUS_MODE: process.env.NIMBUS_MODE || "prod",
      },
      // Logs — PM2 já rotaciona por padrão se pm2-logrotate estiver instalado:
      //   pm2 install pm2-logrotate
      //   pm2 set pm2-logrotate:max_size 50M
      //   pm2 set pm2-logrotate:retain 14
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      time: true,              // timestamp em cada linha
      merge_logs: true,
    },
    // Fase 2.1 — worker dedicado: owna Baileys + consome filas. Necessário em
    // QUEUE_BACKEND=redis. Em memory mode, NÃO subir (server faz tudo).
    {
      name: "nimbus-worker",
      script: "./worker.js",
      cwd: __dirname,
      instances: 1,            // hoje 1 — Fase 2.2 vai shardar por número
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      exp_backoff_restart_delay: 200,   // idem: não martelar quando o Redis está fora
      kill_timeout: 8000,      // mais alto: drain do BullMQ Worker pode levar segundos
      env: {
        NODE_ENV: "production",
        NIMBUS_MODE: process.env.NIMBUS_MODE || "prod",
      },
      out_file: "./logs/worker-out.log",
      error_file: "./logs/worker-error.log",
      time: true,
      merge_logs: true,
    },
    // Backup NÃO roda mais pelo PM2 — o cron horário chama backup-all.sh
    // (dump local + upload B2). Ver deploy/setup-backups.sh e scripts/README.md.
  ],
};
