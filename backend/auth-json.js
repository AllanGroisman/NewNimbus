const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const DATA_DIR = process.env.NIMBUS_DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SECRET_FILE = path.join(DATA_DIR, ".jwt_secret");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Cache em memória: users.json é lido em cada request (requireAuth).
// Invalida em writes; primeira leitura é sync pra preservar comportamento.
let _usersCache = null;

// Emails que recebem role "admin" automaticamente no login/registro.
// Definir via ADMIN_EMAILS=email1@x.com,email2@y.com
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(String(email || "").trim().toLowerCase());
}

// JWT secret persistido em disco — gera uma vez e reusa entre reinícios.
// Em produção, sobrescreva com a env JWT_SECRET.
function loadOrCreateSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, "utf-8").trim();
  const secret = crypto.randomBytes(48).toString("hex");
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}
const JWT_SECRET = loadOrCreateSecret();
const TOKEN_TTL = "30d";

function readUsers() {
  if (_usersCache) return _usersCache;
  if (!fs.existsSync(USERS_FILE)) { _usersCache = []; return _usersCache; }
  try { _usersCache = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8")); }
  catch { _usersCache = []; }
  return _usersCache;
}

// Persistência fire-and-forget pra não bloquear request. Cache atualizado na hora.
function writeUsers(users) {
  _usersCache = users;
  fsp.writeFile(USERS_FILE, JSON.stringify(users, null, 2))
    .catch(err => console.error("[auth] writeUsers falhou:", err.message));
}

// Sincroniza role com ADMIN_EMAILS — chamada em pontos críticos (login, requireAuth).
// Garante que mudanças na env var refletem imediatamente sem precisar re-cadastrar.
function syncRole(user) {
  if (!user) return user;
  const expected = isAdminEmail(user.email) ? "admin" : (user.role === "admin" ? "admin" : "user");
  // Se ADMIN_EMAILS deixou de incluir o email, NÃO rebaixa automaticamente —
  // role "admin" só é removido manualmente via API admin (evita lockout acidental).
  if (user.role !== expected && (expected === "admin" || !user.role)) {
    user.role = expected;
    const users = readUsers();
    const i = users.findIndex(u => u.id === user.id);
    if (i >= 0) {
      users[i].role = expected;
      writeUsers(users);
    }
  } else if (!user.role) {
    user.role = "user";
  }
  return user;
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  if (!rest.role) rest.role = "user";
  return rest;
}

function findByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return readUsers().find(u => u.email === e) || null;
}

function findById(id) {
  return readUsers().find(u => u.id === id) || null;
}

async function register({ name, email, password, phone }) {
  email = String(email || "").trim().toLowerCase();
  name = String(name || "").trim();
  password = String(password || "");

  if (!name) throw new Error("Nome obrigatório");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Email inválido");
  if (password.length < 6) throw new Error("Senha precisa ter ao menos 6 caracteres");

  const users = readUsers();
  if (users.some(u => u.email === email)) throw new Error("Já existe uma conta com este email");

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    phone: phone ? String(phone).trim() : "",
    passwordHash,
    role: isAdminEmail(email) ? "admin" : "user",
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);
  return publicUser(user);
}

async function login({ email, password }) {
  email = String(email || "").trim().toLowerCase();
  password = String(password || "");
  const user = findByEmail(email);
  if (!user) throw new Error("Email ou senha incorretos");
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new Error("Email ou senha incorretos");
  syncRole(user);
  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return { token, user: publicUser(user) };
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// Express middleware — exige Authorization: Bearer <token>
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: "Não autorizado" });
  const user = findById(payload.sub);
  if (!user) return res.status(401).json({ error: "Usuário não encontrado" });
  syncRole(user);
  req.user = publicUser(user);
  next();
}

// Middleware admin — usar APÓS requireAuth
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Acesso restrito a administradores" });
  }
  next();
}

async function updateProfile(userId, updates) {
  const users = readUsers();
  const i = users.findIndex(u => u.id === userId);
  if (i < 0) throw new Error("Usuário não encontrado");
  const allowed = ["name", "phone"];
  for (const k of allowed) {
    if (updates[k] !== undefined) users[i][k] = String(updates[k]).trim();
  }
  writeUsers(users);
  return publicUser(users[i]);
}

async function changePassword(userId, { currentPassword, newPassword }) {
  if (String(newPassword || "").length < 6) throw new Error("Nova senha precisa ter ao menos 6 caracteres");
  const users = readUsers();
  const i = users.findIndex(u => u.id === userId);
  if (i < 0) throw new Error("Usuário não encontrado");
  const ok = await bcrypt.compare(String(currentPassword || ""), users[i].passwordHash);
  if (!ok) throw new Error("Senha atual incorreta");
  users[i].passwordHash = await bcrypt.hash(String(newPassword), 10);
  writeUsers(users);
  return true;
}

// ────────────────────────────────────────────────────────────────────────
// Funções admin (gerenciamento de usuários)
// ────────────────────────────────────────────────────────────────────────

async function listUsers() {
  return readUsers().map(publicUser);
}

async function deleteUser(userId) {
  const users = readUsers();
  const i = users.findIndex(u => u.id === userId);
  if (i < 0) throw new Error("Usuário não encontrado");
  users.splice(i, 1);
  writeUsers(users);
  return true;
}

async function adminSetPassword(userId, newPassword) {
  if (String(newPassword || "").length < 6) throw new Error("Senha precisa ter ao menos 6 caracteres");
  const users = readUsers();
  const i = users.findIndex(u => u.id === userId);
  if (i < 0) throw new Error("Usuário não encontrado");
  users[i].passwordHash = await bcrypt.hash(String(newPassword), 10);
  writeUsers(users);
  return true;
}

async function setUserRole(userId, role) {
  if (role !== "admin" && role !== "user") throw new Error("Role inválida");
  const users = readUsers();
  const i = users.findIndex(u => u.id === userId);
  if (i < 0) throw new Error("Usuário não encontrado");
  users[i].role = role;
  writeUsers(users);
  return publicUser(users[i]);
}

module.exports = {
  register,
  login,
  requireAuth,
  requireAdmin,
  updateProfile,
  changePassword,
  findById,
  publicUser,
  // admin
  listUsers,
  deleteUser,
  adminSetPassword,
  setUserRole,
  isAdminEmail,
};
