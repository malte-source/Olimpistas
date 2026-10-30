"use strict";
// De dónde vino cada alta: referido y peña mandan; si no, el utm del enlace, el sitio que la mandó o "directo"; y cuántas de cada origen llegaron a cada hito.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const mailer = require("../lib/email");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; mailer.enviarPenaVerificada = async () => ({ ok: true, modo: "resend" }); });
after(() => srv && srv.close());
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const ADM = { "x-admin-key": "clave-admin-de-prueba" };
let n = 0;
async function registrar(extra = {}) {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `or${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Origen", ...extra } });
  const { socio } = await r.json();
  return store.getSocioById(socio.id);
}
const origen = (s) => [s.origen_fuente, s.origen_medio, s.origen_campana];

test("el utm del enlace queda como origen (en minúsculas y limpio); el sitio que mandó a la persona sirve si no hay utm; sin nada es 'directo'", async () => {
  assert.deepStrictEqual(origen(await registrar({ origen: { fuente: "Instagram", medio: "story", campana: "Oct26" } })), ["instagram", "story", "oct26"]);
  assert.deepStrictEqual(origen(await registrar({ origen: { referrer: "www.facebook.com".replace("www.", "") } })), ["facebook.com", "", ""]);
  assert.deepStrictEqual(origen(await registrar({ origen: {} })), ["directo", "", ""]);
  assert.deepStrictEqual(origen(await registrar()), ["directo", "", ""]);
  const raro = await registrar({ origen: { fuente: "<script>alert(1)</script>", medio: "x".repeat(100) } });
  assert.strictEqual(raro.origen_fuente, "scriptalert1script", "se sacan los caracteres raros");
  assert.strictEqual(raro.origen_medio.length, 40, "tope de largo");
  assert.deepStrictEqual(origen(await registrar({ origen: "no soy un objeto" })), ["directo", "", ""], "un valor que no es objeto no rompe el alta");
});

test("una invitación manda sobre el utm: referido y peña", async () => {
  const dueño = await registrar(), ref = dueño.ref_codigo;
  assert.strictEqual((await registrar({ ref, origen: { fuente: "instagram" } })).origen_fuente, "referido");
  const id = (await (await api("/penas/solicitud", { metodo: "POST", cuerpo: { nombre: "Peña Origen " + n, ciudad: "Asunción", pais_iso: "PY", presidente: "Presi Dente", contacto: `po${n}-${Date.now()}@ejemplo.com` } })).json()).id;
  await api("/admin/penas/" + id + "/verificar", { metodo: "POST", h: ADM });
  const slug = (await store.getPena(id)).slug;
  const dePena = await registrar({ pena: slug, origen: { fuente: "facebook" } });
  assert.strictEqual(dePena.origen_fuente, "pena");
  assert.strictEqual((await store.solicitudPenaPendiente(dePena.id)).pena_id, id, "queda el pedido a la peña, que todavía tiene que aceptar");
});

test("el panel cuenta cada origen y cuántos llegaron a cada hito", async () => {
  const a = await registrar({ origen: { fuente: "tiktok" } }), b = await registrar({ origen: { fuente: "tiktok" } });
  await registrar({ origen: { fuente: "radio" } });
  await store.updateSocio(a.id, { email_verificado: true });
  await store.registrarEvento(a.id, "primer_canje"); await store.registrarEvento(a.id, "nivel_socio_activado"); await store.registrarEvento(b.id, "primer_pago");
  const d = await (await api("/admin/origenes?dias=30", { h: ADM })).json();
  assert.strictEqual(d.dias, 30);
  const t = d.origenes.find((o) => o.fuente === "tiktok");
  assert.deepStrictEqual([t.registrados, t.verificaron, t.socios, t.canjearon, t.pagaron], [2, 1, 1, 1, 1]);
  assert.ok(d.origenes.some((o) => o.fuente === "radio"));
  assert.ok(!/@/.test(JSON.stringify(d)), "solo totales");
  assert.strictEqual((await api("/admin/origenes?dias=9999", { h: ADM })).status, 200);
  assert.strictEqual((await (await api("/admin/origenes?dias=9999", { h: ADM })).json()).dias, 365, "tope de un año");
  assert.ok((await api("/admin/origenes")).status >= 400, "sin credenciales no");
});

test("el navegador guarda el origen al entrar y lo manda al registrarse; el Dashboard lo muestra", () => {
  const c = leer("public", "js", "common.js"), l = leer("public", "js", "landing.js"), o = leer("public", "js", "onboarding.js"), a = leer("public", "admin.html");
  assert.ok(/oli_origen/.test(c) && /utm_source/.test(c) && /utm_medium/.test(c) && /utm_campaign/.test(c) && /document\.referrer/.test(c) && /return \{ origen, api/.test(c));
  assert.ok(/origen: window\.OLI\.origen\(\)/.test(l) && /origen: window\.OLI\.origen\(\)/.test(o), "los dos registros mandan el origen");
  assert.ok(/id="origenesBox"/.test(a) && /async function cargarOrigenes\(\)/.test(a) && /\/admin\/origenes\?dias=90/.test(a));
});
