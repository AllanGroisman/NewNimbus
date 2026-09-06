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

// ── Telefone de uma conta de WhatsApp ───────────────────────────────────────
// Espelho de toWhatsappPhone/formatWhatsappPhone de backend/utils/phone.js. Mais
// frouxo que o toStoredPhone acima de propósito: o número precisa bater com a
// conta que o WhatsApp conhece, e contas antigas de 8 dígitos seguem ativas. Se
// mudar lá, mude aqui.
export function toWhatsappPhone(value) {
  let d = normalizePhone(value);
  if ((d.length === 13 || d.length === 12) && d.startsWith("55")) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return "";
  if (!DDDS.has(Number(d.slice(0, 2)))) return "";
  if (d.length === 11 && d[2] !== "9") return "";
  if (d.length === 10 && !"6789".includes(d[2])) return "";
  return `55${d}`;
}

export function formatWhatsappPhone(value) {
  const stored = toWhatsappPhone(value);
  if (!stored) return normalizePhone(value);
  const d = stored.slice(2);
  const meio = d.length === 11 ? 7 : 6;
  return `(${d.slice(0, 2)}) ${d.slice(2, meio)}-${d.slice(meio)}`;
}

// Máscara do campo de pareamento. A maskPhoneInput acima assume 9 dígitos (é do
// cadastro) e renderizaria "(55) 96168-060" para um número de 8.
export function maskWhatsappPhoneInput(value) {
  let d = normalizePhone(value);
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  d = d.slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  // Só passa a 5 dígitos no primeiro bloco quando o número de fato tem 11.
  const meio = d.length > 10 ? 7 : 6;
  return `(${d.slice(0, 2)}) ${d.slice(2, meio)}-${d.slice(meio)}`;
}
