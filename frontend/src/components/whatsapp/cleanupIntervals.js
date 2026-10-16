// As frequências da limpeza automática (task 13). O servidor só aceita estas
// (whatsapp/chat-cleanup.js INTERVALS).
export const CLEANUP_INTERVALS = [
  { hours: 6, label: "a cada 6 horas" },
  { hours: 12, label: "a cada 12 horas" },
  { hours: 24, label: "a cada 24 horas" },
  { hours: 72, label: "a cada 3 dias" },
  { hours: 168, label: "a cada 7 dias" },
];
export const intervalLabel = (h) => (CLEANUP_INTERVALS.find(i => i.hours === h)?.label || `a cada ${h}h`);
