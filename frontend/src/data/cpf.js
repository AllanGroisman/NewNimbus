// CPF — mesmo algoritmo de backend/utils/cpf.js, aqui só para o campo avisar
// o usuário antes de bater no servidor. A validação que vale é a do backend.
// Se mudar lá, mude aqui.

export function normalizeCpf(value) {
  return String(value || "").replace(/\D/g, "");
}

export function isValidCpf(value) {
  const cpf = normalizeCpf(value);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  for (const [len, pos] of [[9, 10], [10, 11]]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (pos - i);
    const rest = (sum * 10) % 11;
    const digit = rest === 10 ? 0 : rest;
    if (digit !== Number(cpf[len])) return false;
  }
  return true;
}

// Máscara progressiva, para usar no onChange sem atrapalhar quem está digitando.
export function maskCpfInput(value) {
  const d = normalizeCpf(value).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
