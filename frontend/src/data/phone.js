// Telefone — mesmo algoritmo de backend/utils/phone.js, aqui só para o campo
// avisar o usuário antes de bater no servidor. A validação que vale é a do
// backend. Se mudar lá, mude aqui.

const DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

// 55 + DDD + 9 dígitos, ou "" se não for celular brasileiro.
export function toStoredPhone(value) {
  let d = normalizePhone(value);
  if (d.length === 13 && d.startsWith("55")) d = d.slice(2);
  if (d.length !== 11) return "";
  if (!DDDS.has(Number(d.slice(0, 2)))) return "";
  if (d[2] !== "9") return "";
  return `55${d}`;
}

export function isValidPhone(value) {
  return toStoredPhone(value) !== "";
}

export function formatPhone(value) {
  const stored = toStoredPhone(value);
  if (!stored) return normalizePhone(value);
  const d = stored.slice(2);
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

// Máscara progressiva, para usar no onChange sem atrapalhar quem está digitando.
// O 55 do país é descartado enquanto digita: o campo mostra (DDD) 9xxxx-xxxx e
// quem cola "+55 11 ..." vê o número acomodar sozinho.
export function maskPhoneInput(value) {
  let d = normalizePhone(value);
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  d = d.slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
