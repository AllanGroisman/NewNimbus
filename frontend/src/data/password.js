// Regras de senha forte — mesmo conjunto validado em backend/auth/pg.js
// (validatePassword). Fica aqui porque duas telas escolhem senha: o
// cadastro/reset (Login.jsx) e a primeira senha de quem assinou pela landing
// (BemVindo.jsx).
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;

export function passwordChecks(pw) {
  const s = String(pw || "");
  return {
    length: s.length >= MIN_PASSWORD,
    lower: /[a-z]/.test(s),
    upper: /[A-Z]/.test(s),
    number: /[0-9]/.test(s),
  };
}

export function passwordOk(pw) {
  const c = passwordChecks(pw);
  return c.length && c.lower && c.upper && c.number;
}
