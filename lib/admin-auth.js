"use strict";

/**
 * lib/admin-auth.js — Cuentas reales del panel admin (usuario + contraseña) con roles.
 *
 * Espeja lib/auth.js (bcrypt cost 10, sesiones con token aleatorio), pero para admins.
 * - Sesión = token de 32 bytes en admin_sesiones, TTL 12h. Viaja en header `x-admin-token`.
 * - Roles: owner | finanzas | marketing | soporte | lectura. `owner` puede todo.
 * - La seguridad real es server-side (can()/requirePerm en routes.js); el front solo oculta.
 */

const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { getStore } = require("../data/store");

const BCRYPT_COST = 10;
const PASSWORD_MIN_LEN = 8;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas
const ROLES = ["owner", "finanzas", "marketing", "soporte", "lectura"];

// Permisos por rol (owner = todo). Las lecturas no requieren permiso (cualquier rol logueado las ve).
const PERMS_POR_ROL = {
  owner: ["*"],
  finanzas: ["pagos.write", "socios.write", "export"],
  marketing: ["contenido.write", "campanas.write", "export"],
  soporte: ["socios.write", "moderacion", "padron.resolve", "export"],
  lectura: [],  // solo ver; NO puede exportar PII
};
// Áreas del nav visibles por rol (UX; el server igual valida cada acción).
const AREAS_POR_ROL = {
  owner: ["dashboard", "socios", "pagos", "campanas", "contenido", "sistema"],
  finanzas: ["dashboard", "socios", "pagos"],
  marketing: ["dashboard", "socios", "campanas", "contenido"],
  soporte: ["dashboard", "socios", "contenido", "sistema"],
  lectura: ["dashboard", "socios", "pagos", "campanas", "contenido"],
};

function can(rol, perm) {
  if (rol === "owner") return true;
  const list = PERMS_POR_ROL[rol] || [];
  return list.includes("*") || list.includes(perm);
}

// Acepta usuario simple o EMAIL (ej. gerenciageneral@clubolimpia.com.py). Se guarda en minúsculas.
const usuarioValido = (u) => typeof u === "string" && /^[a-z0-9._%+@-]{3,64}$/.test(u);

async function crearAdminUsuario({ usuario, nombre, password, rol }) {
  usuario = String(usuario || "").toLowerCase().trim();
  if (!usuarioValido(usuario)) throw httpError(400, "Usuario inválido (3-32, letras/números/._-)");
  if (!password || password.length < PASSWORD_MIN_LEN) throw httpError(400, `La contraseña debe tener al menos ${PASSWORD_MIN_LEN} caracteres`);
  if (!ROLES.includes(rol)) throw httpError(400, "Rol inválido");
  const store = getStore();
  if (await store.getAdminUsuarioByUsuario(usuario)) throw httpError(409, "Ya existe un usuario con ese nombre");
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const u = await store.createAdminUsuario({ usuario, nombre, passwordHash, rol });
  return sanitize(u);
}

async function loginAdmin({ usuario, password }) {
  const store = getStore();
  const u = await store.getAdminUsuarioByUsuario(usuario);
  if (!u || !u.activo) throw httpError(401, "Usuario o contraseña incorrectos");
  const ok = await bcrypt.compare(password || "", u.password_hash || "");
  if (!ok) throw httpError(401, "Usuario o contraseña incorrectos");
  const token = crypto.randomBytes(32).toString("base64url");
  const expira = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await store.updateAdminUsuario(u.id, { ultimo_acceso: new Date().toISOString() });
  if (store.purgarAdminSesionesVencidas) { try { await store.purgarAdminSesionesVencidas(); } catch (e) {} } // housekeeping
  await store.createAdminSession(u.id, u.rol, token, expira); // crear la sesión al final
  return { token, usuario: u.usuario, nombre: u.nombre, rol: u.rol, expira };
}

async function logoutAdmin(token) { if (token) await getStore().deleteAdminSession(token); }

// Cambiar/resetear contraseña: re-hashea e invalida todas las sesiones del usuario.
async function setAdminPassword(id, password) {
  if (!password || password.length < PASSWORD_MIN_LEN) throw httpError(400, `La contraseña debe tener al menos ${PASSWORD_MIN_LEN} caracteres`);
  const store = getStore();
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  await store.updateAdminUsuario(id, { password_hash: passwordHash });
  await store.deleteAdminSessionsByUser(id);
}

function sanitize(u) { if (!u) return null; const { password_hash, ...rest } = u; return rest; }
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = {
  ROLES, PERMS_POR_ROL, AREAS_POR_ROL, can, SESSION_TTL_MS, PASSWORD_MIN_LEN,
  crearAdminUsuario, loginAdmin, logoutAdmin, setAdminPassword, sanitize,
};
