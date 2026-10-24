"use strict";
// Cuenta nueva = correo pendiente de validar: hasta confirmarlo no puede pujar, pagar, comprar ni validar su cédula de socio.
// Las cuentas anteriores a la regla no se bloquean. Si no hay proveedor de correo, no se exige nada.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.RESEND_API_KEY = "re_de_prueba";

// El proveedor de correo es falso: ningún test manda mails de verdad.
const fetchReal = global.fetch;
const correos = [];
global.fetch = (u, o) => {
  if (String(u).includes("resend.com")) { try { correos.push(JSON.parse(o.body)); } catch (e) { correos.push({}); } return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: "x" }), text: async () => "{}" }); }
  return fetchReal(u, o);
};

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => { srv && srv.close(); global.fetch = fetchReal; });
const api = (ruta, { metodo = "GET", cuerpo, h = {}, redirect } = {}) => fetch(url + "/api" + ruta, { method: metodo, redirect, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function nuevo() {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `vc${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Prueba" } });
  const { token, socio } = await r.json();
  return { id: socio.id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}

test("la cuenta nace con el correo pendiente de validar y se manda el enlace", async () => {
  const antes = correos.length;
  const A = await nuevo();
  const s = await store.getSocioById(A.id);
  assert.strictEqual(s.email_verificado, false);
  assert.strictEqual(s.verif_exigida, true);
  assert.ok(s.verif_token, "token guardado");
  await new Promise((x) => setTimeout(x, 30));
  assert.ok(correos.length > antes, "se envió el correo de verificación");
});

test("pendiente: no puede pujar, pagar, comprar una membresía ni validar su cédula; sí puede ver su carnet", async () => {
  const A = await nuevo();
  for (const [ruta, cuerpo, que] of [
    ["/subastas/x/pujar", { monto: 1000 }, "pujar"],
    ["/subastas/x/pagar", {}, "pagar un lote"],
    ["/membresia/unirse", { tier: "premium" }, "comprar una membresía"],
    ["/perfil/validar-socio", { cedula: "1234567" }, "validar tu cédula de socio"],
  ]) {
    const r = await api(ruta, { metodo: "POST", h: A.h, cuerpo });
    assert.strictEqual(r.status, 403, ruta);
    assert.match((await r.json()).error, new RegExp("Confirmá tu correo para " + que));
  }
  const silen = await (await api("/perfil/validar-socio", { metodo: "POST", h: A.h, cuerpo: { silencioso: true } })).json();
  assert.strictEqual(silen.omitido, true, "el reintento silencioso no se hace sin correo confirmado");
  assert.strictEqual((await api("/carnet", { h: A.h })).status, 200, "el carnet sigue disponible");
});

test("reenviar: manda otro enlace con otro token, y no más de uno por minuto", async () => {
  const A = await nuevo();
  const t0 = (await store.getSocioById(A.id)).verif_token;
  const antes = correos.length;
  const r1 = await api("/auth/reenviar-verificacion", { metodo: "POST", h: A.h, cuerpo: {} });
  assert.strictEqual(r1.status, 200);
  await new Promise((x) => setTimeout(x, 30));
  assert.ok(correos.length > antes);
  assert.notStrictEqual((await store.getSocioById(A.id)).verif_token, t0);
  const r2 = await api("/auth/reenviar-verificacion", { metodo: "POST", h: A.h, cuerpo: {} });
  assert.strictEqual(r2.status, 429);
  assert.strictEqual((await api("/auth/reenviar-verificacion", { metodo: "POST", cuerpo: {} })).status, 401, "hace falta sesión");
});

test("confirmar el correo con el enlace levanta el bloqueo; el enlace sirve una sola vez", async () => {
  const A = await nuevo();
  const token = (await store.getSocioById(A.id)).verif_token;
  const r = await api("/auth/verificar?token=" + token, { redirect: "manual" });
  assert.strictEqual(r.status, 302);
  assert.match(r.headers.get("location"), /verificado=1$/);
  const s = await store.getSocioById(A.id);
  assert.strictEqual(s.email_verificado, true);
  const p = await api("/subastas/x/pujar", { metodo: "POST", h: A.h, cuerpo: { monto: 1000 } });
  assert.notStrictEqual(p.status, 403, "ya no lo frena el correo");
  const otra = await api("/auth/verificar?token=" + token, { redirect: "manual" });
  assert.match(otra.headers.get("location"), /verificado=0$/, "el enlace ya se usó");
  assert.match((await (await api("/auth/reenviar-verificacion", { metodo: "POST", h: A.h, cuerpo: {} })).json()).ya ? "ya" : "no", /ya/);
});

test("las cuentas anteriores a la regla no se bloquean aunque no hayan confirmado", async () => {
  const L = await nuevo();
  await store.updateSocio(L.id, { verif_exigida: false });
  const p = await api("/subastas/x/pujar", { metodo: "POST", h: L.h, cuerpo: { monto: 1000 } });
  assert.notStrictEqual(p.status, 403);
});

test("pantalla: aviso para confirmar el correo con reenvío, y mensaje al volver del enlace", () => {
  const s = leer("public", "js", "socio.js");
  assert.match(s, /socio-banner-correo/);
  assert.match(s, /api\("\/auth\/reenviar-verificacion"/);
  assert.match(s, /get\("verificado"\)/);
  const i = leer("public", "js", "i18n.js");
  for (const k of ["vf_banner", "vf_reenviar", "vf_enviado", "vf_ok", "vf_mal"]) assert.ok(i.split(" " + k + ":").length - 1 >= 2, k);
});

test("migración 0016: columna verif_exigida aditiva y en false para las cuentas que ya existen", () => {
  const m = leer("migraciones", "0016_verificacion_exigida.sql");
  assert.match(m, /ADD COLUMN IF NOT EXISTS verif_exigida boolean NOT NULL DEFAULT false/);
  assert.ok(!/UPDATE|DROP|DELETE/i.test(m.replace(/--.*$/gm, "")));
});
