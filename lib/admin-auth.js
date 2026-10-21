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
const ROLES = ["owner", "finanzas", "marketing", "soporte", "lectura", "cd", "comercial", "operaciones"];

// Permisos por rol (owner = todo). Las lecturas no requieren permiso (cualquier rol logueado las ve).
const PERMS_POR_ROL = {
  owner: ["*"],
  finanzas: ["pagos.write", "socios.write", "export", "penas.write"],
  marketing: ["contenido.write", "campanas.write", "export", "puntos.write", "beneficios.write", "subastas.write", "penas.write"],
  soporte: ["socios.write", "moderacion", "padron.resolve", "export", "atencion.write"],
  lectura: [],  // solo ver; NO puede exportar PII
  cd: [],       // Comisión Directiva: ve el tablero y las decisiones en solo lectura
  comercial: ["beneficios.write", "penas.write", "export"],
  operaciones: ["subastas.write", "contenido.write", "atencion.write", "socios.write"],
};

// Secciones del panel y qué rol ve cuál. Los roles "restringidos" (RESTRINGIDOS) solo entran a lo que
// figura acá (default-deny por ruta); el resto conserva el comportamiento histórico: ve todo y escribe con permiso.
const SECCIONES = ["tablero", "decisiones", "hinchas", "atencion", "campanas", "beneficios", "puntos", "penas", "subastas", "estadio", "integraciones", "roles", "contenido", "pagos"];
const VER_POR_ROL = {
  owner: SECCIONES.slice(),
  finanzas: ["tablero", "hinchas", "pagos", "subastas", "penas", "integraciones"],
  marketing: ["tablero", "hinchas", "campanas", "contenido", "beneficios", "puntos", "penas", "subastas"],
  soporte: ["tablero", "hinchas", "atencion", "contenido"],
  lectura: ["tablero", "hinchas", "pagos", "campanas", "contenido", "beneficios", "puntos", "penas", "subastas"],
  cd: ["tablero", "decisiones", "beneficios", "puntos", "penas", "subastas"],  // sin datos personales de hinchas
  comercial: ["tablero", "beneficios", "penas", "subastas"],
  operaciones: ["tablero", "hinchas", "atencion", "estadio", "contenido", "subastas"],
};
const RESTRINGIDOS = ["cd", "marketing", "comercial", "operaciones"];
const SOLO_LECTURA = ["cd", "lectura"];

// Ruta (sin /api) → sección. Lo que no figura, en un rol restringido, se niega.
const SECCION_DE_SEGMENTO = {
  whoami: "tablero", logout: "tablero", buscar: "tablero", tablero: "tablero", resumen: "tablero", reportes: "tablero", salud: "tablero",
  decisiones: "decisiones",
  socios: "hinchas", segmento: "hinchas", segmentos: "hinchas", padron: "hinchas", selfies: "hinchas", abandonos: "hinchas",
  atencion: "atencion", ayuda: "atencion",
  campanas: "campanas", "email-metricas": "campanas", ghl: "campanas",
  beneficios: "beneficios", comercios: "beneficios",
  puntos: "puntos", penas: "penas", subastas: "subastas", sorteos: "subastas",
  estadio: "estadio", preventas: "estadio",
  integraciones: "integraciones",
  usuarios: "roles", roles: "roles", acciones: "roles",
  contenido: "contenido", actualizaciones: "contenido", encuestas: "contenido",
  "pagos-recibidos": "pagos", cuadre: "pagos", pedidos: "pagos",
};
function seccionDeRuta(path) {
  const seg = String(path || "").split("?")[0].split("/").filter(Boolean);
  if (seg[0] !== "admin" || !seg[1]) return null;
  if (seg[1] === "export") return /^pagos/.test(seg[2] || "") ? "pagos" : /^socios/.test(seg[2] || "") ? "hinchas" : null;
  return SECCION_DE_SEGMENTO[seg[1]] || null;
}
const restringido = (rol) => RESTRINGIDOS.includes(rol);
function puedeVer(rol, seccion) {
  if (rol === "owner") return true;
  if (!restringido(rol)) return true; // histórico: lecturas abiertas a cualquier rol logueado
  return (VER_POR_ROL[rol] || []).includes(seccion);
}
function seccionesVisibles(rol) {
  return (VER_POR_ROL[rol] || VER_POR_ROL.lectura).slice();
}
// ¿Puede este rol llamar a esta ruta? (default-deny para los restringidos)
function accesoRuta(rol, path) {
  if (rol === "owner" || !restringido(rol)) return { ok: true };
  const s = seccionDeRuta(path);
  if (s && (VER_POR_ROL[rol] || []).includes(s)) return { ok: true, seccion: s };
  return { ok: false, seccion: s };
}
// Sección → áreas del nav (el panel agrupa en 6 áreas; "ayuda"/"atencion" cuelgan de socios).
const AREA_DE_SECCION = { tablero: "dashboard", hinchas: "socios", atencion: "atencion", pagos: "pagos", campanas: "campanas",
  decisiones: "decisiones", beneficios: "contenido", puntos: "contenido", penas: "contenido", subastas: "contenido", estadio: "contenido", contenido: "contenido",
  integraciones: "sistema", roles: "sistema" };
// Áreas del nav visibles por rol (UX; el server igual valida cada acción).
const AREAS_POR_ROL = {
  owner: ["dashboard", "socios", "atencion", "pagos", "campanas", "contenido", "decisiones", "sistema"],
  finanzas: ["dashboard", "socios", "pagos", "contenido", "sistema"],
  marketing: ["dashboard", "socios", "campanas", "contenido"],
  soporte: ["dashboard", "socios", "atencion", "contenido", "sistema"],
  lectura: ["dashboard", "socios", "pagos", "campanas", "contenido"],
  cd: ["dashboard", "contenido", "decisiones"],
  comercial: ["dashboard", "contenido"],
  operaciones: ["dashboard", "socios", "atencion", "contenido"],
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
  ROLES, PERMS_POR_ROL, AREAS_POR_ROL, SECCIONES, VER_POR_ROL, RESTRINGIDOS, SOLO_LECTURA, AREA_DE_SECCION,
  can, puedeVer, seccionDeRuta, seccionesVisibles, accesoRuta, SESSION_TTL_MS, PASSWORD_MIN_LEN,
  crearAdminUsuario, loginAdmin, logoutAdmin, setAdminPassword, sanitize,
};
