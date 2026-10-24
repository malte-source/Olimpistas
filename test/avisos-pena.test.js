"use strict";
// Avisos del ciclo de vida de una peña: solicitud recibida y pausada o reactivada por el club (una vez por cambio).
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const app = require("../server");
const mailer = require("../lib/email");
const { getStore } = require("../data/store");
const store = getStore();

let srv, url, recibidas, estados;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
beforeEach(() => {
  recibidas = []; estados = [];
  mailer.enviarPenaSolicitudRecibida = async (d, x) => { recibidas.push({ a: d.email, pena: x.pena.nombre }); return { ok: true }; };
  mailer.enviarPenaEstado = async (d, x) => { estados.push({ a: d.email, estado: x.estado }); return { ok: true }; };
  mailer.enviarPenaVerificada = async () => ({ ok: true, modo: "resend" });
});
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const ADM = { "x-admin-key": "clave-admin-de-prueba" };
const espera = () => new Promise((x) => setTimeout(x, 30));
let n = 0;
async function solicitar() {
  n++;
  const contacto = `pena${n}-${Date.now()}@ejemplo.com`;
  const r = await api("/penas/solicitud", { metodo: "POST", cuerpo: { nombre: "Peña Aviso " + n, ciudad: "Asunción", pais_iso: "PY", presidente: "Presi Dente", contacto } });
  return { status: r.status, contacto, id: (await r.json()).id };
}

test("al pedir una peña llega la confirmación al correo de contacto", async () => {
  const s = await solicitar();
  assert.strictEqual(s.status, 201);
  await espera();
  assert.deepStrictEqual(recibidas, [{ a: s.contacto, pena: "Peña Aviso " + n }]);
});

test("pausar y reactivar avisan a la comisión una sola vez por cambio; repetir el mismo estado no vuelve a avisar", async () => {
  const s = await solicitar();
  assert.strictEqual((await api("/admin/penas/" + s.id + "/verificar", { metodo: "POST", h: ADM })).status, 200);
  const estado = (e) => api("/admin/penas/" + s.id + "/estado", { metodo: "POST", h: ADM, cuerpo: { estado: e } });
  assert.strictEqual((await estado("pausada")).status, 200); await espera();
  assert.deepStrictEqual(estados, [{ a: s.contacto, estado: "pausada" }]);
  await estado("pausada"); await espera();
  assert.strictEqual(estados.length, 1, "pausarla otra vez no repite el aviso");
  await estado("verificada"); await espera();
  assert.deepStrictEqual(estados.map((e) => e.estado), ["pausada", "verificada"]);
});

test("los textos nuevos no prometen el fondo (está apagado) y escapan lo que escribe el comercio", () => {
  const fs = require("fs"), path = require("path");
  const e = fs.readFileSync(path.join(__dirname, "..", "lib", "email.js"), "utf8");
  const verificada = e.slice(e.indexOf("async function enviarPenaVerificada"), e.indexOf("async function enviarPenaSumoSocio"));
  assert.ok(!/fondo/i.test(verificada), "el correo de peña verificada no menciona el fondo");
  for (const f of ["enviarCanjeExitoso", "enviarOfertaRechazada", "enviarPenaSolicitudRecibida", "enviarPenaEstado"]) assert.ok(e.includes(f + ","), f + " exportada");
  assert.ok(/\$\{h\(motivo/.test(e) && /\$\{h\(titulo/.test(e) && /\$\{h\(comercio\)\}/.test(e), "lo escrito por el comercio va escapado");
});

test("el último paso del registro dice 'confirmá tu correo' a la vista, permite reenviar y manda el idioma", () => {
  const fs = require("fs"), path = require("path");
  const o = fs.readFileSync(path.join(__dirname, "..", "public", "js", "onboarding.js"), "utf8"), i = fs.readFileSync(path.join(__dirname, "..", "public", "js", "i18n.js"), "utf8");
  assert.ok(/ob-confirma/.test(o) && /id="obReenviar"/.test(o) && /\/auth\/reenviar-verificacion/.test(o));
  assert.ok(/!yo\.email_verificado/.test(o), "solo si el correo todavía no está confirmado");
  assert.ok(/idioma: window\.OLI_I18N \? window\.OLI_I18N\.lang\(\) : undefined/.test(o), "el onboarding manda el idioma, como el modal de la landing");
  for (const k of ["ob_conf_t", "ob_conf_p", "ob_conf_re"]) assert.strictEqual((i.match(new RegExp("\\b" + k + ":", "g")) || []).length, 2, k + " en es y en");
  assert.ok(!/Subí tu carnet a Plus, gratis|upgrade your card to Plus, free/i.test(i), "el banner de invitación habla del nivel Socio, no de Plus");
});
