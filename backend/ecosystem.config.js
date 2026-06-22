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
      max_memory_restart: "1G",
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
    // Backup REMOTO (S3-compatível) — sobe último snapshot 1x/dia às 03h.
    // Sem env BACKUP_S3_* setadas, sai exit 0 sem fazer nada (não polui logs).
    {
      name: "nimbus-backup-remote",
      script: "./scripts/backup-remote.js",
      cwd: __dirname,
      instances: 1,
      autorestart: false,
      cron_restart: "0 3 * * *",
      watch: false,
      env: { NODE_ENV: "production", NIMBUS_MODE: process.env.NIMBUS_MODE || "prod" },
      out_file: "./logs/backup-remote-out.log",
      error_file: "./logs/backup-remote-error.log",
      time: true,
    },
  ],
};
