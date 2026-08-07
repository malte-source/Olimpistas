"use strict";

/**
 * lib/auth.js — Registro, login y sesiones para socios (Olimpistas).
 *
 * - Password con bcrypt (cost 10), mínimo 8 caracteres.
 * - Sesión = token aleatorio de 32 bytes guardado en el store, TTL configurable.
 * - El token viaja en cookie httpOnly `olimpista_sess` y/o header Authorization Bearer.
 */

const crypto = require("crypto");
const bcrypt = require("bcrypt");
const log = require("./log");
const { getStore } = require("../data/store");
const { SESSION_TTL_MS } = require("../config");

const BCRYPT_COST = 10;
const PASSWORD_MIN_LEN = 8;
const COOKIE = "olimpista_sess";

const emailValido = (e) => typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function registrar({ email, password, nombre, apellido, telefono, cedula, ref, idioma }) {
  if (!emailValido(email)) throw httpError(400, "Email inválido");
  if (!password || password.length < PASSWORD_MIN_LEN)
    throw httpError(400, `La contraseña debe tener al menos ${PASSWORD_MIN_LEN} caracteres`);

  const store = getStore();
  if (await store.getSocioByEmail(email)) throw httpError(409, "Ya existe una cuenta con ese email");

  // Atribución de referido (best-effort: un código inválido NUNCA rompe el alta).
  let referidoPor = null;
  if (ref && store.getSocioByRefCodigo) {
    try { const r = await store.getSocioByRefCodigo(ref); if (r) referidoPor = r.id; } catch (e) {}
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const socio = await store.createSocio({ email, passwordHash, nombre, apellido, telefono, cedula, referidoPor, idioma });
  const token = await abrirSesion(socio.id);
  return { socio: sanitize(socio), token };
}

async function login({ email, password }) {
  const store = getStore();
  const socio = await store.getSocioByEmail(email);
  if (!socio) throw httpError(401, "Email o contraseña incorrectos");
  const ok = await bcrypt.compare(password || "", socio.password_hash);
  if (!ok) throw httpError(401, "Email o contraseña incorrectos");
  const token = await abrirSesion(socio.id);
  return { socio: sanitize(socio), token };
}

// Pedido de recuperación: genera token (1h) y lo guarda. NO revela si el email existe.
async function solicitarReset({ email }) {
  if (!emailValido(email)) return { ok: true };
  const store = getStore();
  const socio = await store.getSocioByEmail(email);
  if (!socio) return { ok: true };
  const token = crypto.randomBytes(24).toString("base64url");
  const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hora
  await store.updateSocio(socio.id, { reset_token: token, reset_token_exp: exp });
  return { ok: true, socio: sanitize(socio), token };
}

// Setea la nueva contraseña validando el token + expiración.
async function resetearPassword({ token, password }) {
  if (!token) throw httpError(400, "Enlace inválido");
  if (!password || password.length < PASSWORD_MIN_LEN)
    throw httpError(400, `La contraseña debe tener al menos ${PASSWORD_MIN_LEN} caracteres`);
  const store = getStore();
  const socio = store.getSocioByResetToken ? await store.getSocioByResetToken(token) : null;
  if (!socio) throw httpError(400, "El enlace es inválido o ya se usó");
  if (socio.reset_token_exp && new Date(socio.reset_token_exp).getTime() < Date.now())
    throw httpError(400, "El enlace expiró. Pedí uno nuevo.");
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  await store.updateSocio(socio.id, { password_hash: passwordHash, reset_token: null, reset_token_exp: null });
  // Invalida TODAS las sesiones del socio: si una sesión fue robada, el reset la expulsa.
  if (store.borrarSesionesDeSocio) { try { await store.borrarSesionesDeSocio(socio.id); } catch (e) {} }
  return { ok: true };
}

async function abrirSesion(socioId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expira = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await getStore().createSession(socioId, token, expira);
  return token;
}

async function logout(token) {
  if (token) await getStore().deleteSession(token);
}

function tokenFromReq(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return req.cookies?.[COOKIE] || null;
}

/** Middleware: adjunta req.socio si hay sesión válida (no bloquea). */
async function attachSocio(req, _res, next) {
  if (req._attached) return next();   // idempotente: no re-consultar si ya corrió en esta request
  req._attached = true;
  try {
    const token = tokenFromReq(req);
    if (token) {
      const r = await getStore().getSession(token);
      if (r) { req.socio = sanitize(r.socio); req.sessionToken = token; }
    }
  } catch (e) { log.error({ err: e.message }, "auth attachSocio"); }
  next();
}

/** Middleware: exige sesión válida. */
function requireSocio(req, res, next) {
  if (!req.socio) return res.status(401).json({ error: "Necesitás iniciar sesión" });
  next();
}

function sanitize(socio) {
  if (!socio) return null;
  const { password_hash, ...rest } = socio;
  return rest;
}

function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}

module.exports = {
  COOKIE, registrar, login, logout, attachSocio, requireSocio, tokenFromReq, sanitize,
  solicitarReset, resetearPassword,
};
