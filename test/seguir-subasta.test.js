"use strict";
// P6 · Subasta que se sigue sola: quien pujó recibe UN aviso cuando faltan 3 minutos y UNO cuando el lote cierra sin que haya ganado.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const pushLib = require("../lib/push");
const { getStore } = require("../data/store");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url, enviados;
const avisarOriginal = pushLib.avisar;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => { pushLib.avisar = avisarOriginal; srv && srv.close(); });
beforeEach(() => { enviados = []; pushLib.avisar = async (_st, socioId, tipo, payload) => { enviados.push({ socioId, tipo, ...payload }); return 1; }; });
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const CRON = { "x-cron-token": "secreto-de-cron-de-prueba" };
const barrido = async () => { assert.strictEqual((await api("/cron/subastas", { metodo: "POST", h: CRON, cuerpo: {} })).status, 200); };
let n = 0;
const socio = async () => (await store.createSocio({ email: `sg${++n}-${Date.now()}@ejemplo.com`, passwordHash: "x", nombre: "Postor" }));
const min = (m) => new Date(Date.now() + m * 60000).toISOString();
// Lote con tres postores (el último va ganando). Las pujas se hacen con tiempo de sobra: pujar sobre el cierre lo extendería.
async function lote(titulo) {
  const [a, b, c] = [await socio(), await socio(), await socio()];
  const s = await store.crearSubasta({ titulo, precio_inicial: 100000, incremento: 10000, estado: "activa", termina: min(600) });
  for (const [p, monto] of [[a, 110000], [b, 120000], [c, 130000]]) assert.ok((await store.pujar({ subastaId: s.id, socioId: p.id, monto })).ok);
  return { s, a, b, c };
}

test("el cron de subastas pide el token", async () => {
  assert.strictEqual((await api("/cron/subastas", { metodo: "POST", cuerpo: {} })).status, 401);
  assert.strictEqual((await api("/cron/subastas", { metodo: "POST", h: { "x-cron-token": "otro" }, cuerpo: {} })).status, 401);
});

test("faltan 3 minutos: cada postor recibe UN aviso (quien va ganando, el suyo; el resto, que todavía puede pujar) y no se repite", async () => {
  const { s, a, b, c } = await lote("Camiseta " + (++n));
  await barrido();
  assert.strictEqual(enviados.filter((e) => /Quedan 3 minutos/.test(e.titulo) && e.titulo.includes(s.titulo)).length, 0, "con 10 horas por delante no se avisa nada");
  await store.updateSubasta(s.id, { termina: min(2) });
  await barrido();
  const av = enviados.filter((e) => e.titulo === "Quedan 3 minutos: " + s.titulo);
  assert.deepStrictEqual(av.map((e) => e.socioId).sort(), [a.id, b.id, c.id].sort());
  assert.ok(av.every((e) => e.tipo === "subasta"), "tipo subasta: respeta las preferencias de cada persona");
  assert.match(av.find((e) => e.socioId === c.id).cuerpo, /Vas ganando con ₲ 130\.000/);
  assert.match(av.find((e) => e.socioId === a.id).cuerpo, /Hoy va ₲ 130\.000\. Todavía podés pujar/);
  assert.ok(av.every((e) => e.url === "/subasta/" + encodeURIComponent(s.slug || s.id)));
  await barrido(); await barrido();
  assert.strictEqual(enviados.filter((e) => e.titulo === "Quedan 3 minutos: " + s.titulo).length, 3, "una sola vez por lote");
});

test("al cerrar: quienes no ganaron reciben UN aviso; el ganador no (a él le llega su correo con el plazo de pago)", async () => {
  const { s, a, b, c } = await lote("Pelota " + (++n));
  await store.updateSubasta(s.id, { estado: "cerrada", termina: min(-5), ganador_id: c.id, adjudicado_a: c.id, pago_vence: min(60 * 72) });
  await barrido();
  const fin = enviados.filter((e) => e.titulo === "Terminó " + s.titulo);
  assert.deepStrictEqual(fin.map((e) => e.socioId).sort(), [a.id, b.id].sort());
  assert.match(fin[0].cuerpo, /Ganó otra persona con ₲ 130\.000/);
  await barrido();
  assert.strictEqual(enviados.filter((e) => e.titulo === "Terminó " + s.titulo).length, 2, "una sola vez por lote");
});

test("un lote que cerró hace más de un día no se avisa; uno sin pujas no avisa a nadie", async () => {
  const { s, c } = await lote("Viejo " + (++n));
  await store.updateSubasta(s.id, { estado: "cerrada", termina: min(-60 * 30), ganador_id: c.id, adjudicado_a: c.id });
  const vacio = await store.crearSubasta({ titulo: "Sin pujas " + (++n), precio_inicial: 100000, estado: "activa", termina: min(2) });
  await barrido();
  assert.strictEqual(enviados.filter((e) => e.titulo.includes(s.titulo)).length, 0);
  assert.strictEqual(enviados.filter((e) => e.titulo.includes(vacio.titulo)).length, 0);
});

test("en la segunda ronda, quien recibió el lote no recibe el aviso de 'terminó' y el primer postor sí", async () => {
  const { s, a, b, c } = await lote("Ronda dos " + (++n));
  await store.updateSubasta(s.id, { estado: "cerrada", termina: min(-5), ganador_id: c.id, adjudicado_a: b.id, ronda: 2, pago_vence: min(60 * 48) });
  await barrido();
  const fin = enviados.filter((e) => e.titulo === "Terminó " + s.titulo).map((e) => e.socioId).sort();
  assert.deepStrictEqual(fin, [a.id, c.id].sort());
});

test("en el detalle del lote se ve que lo sigue (con texto es/en) y se oculta al cerrar", () => {
  const js = leer("public", "js", "socio.js"), i18n = leer("public", "js", "i18n.js");
  assert.ok(/id="subSigue"/.test(js) && /sigue\.hidden = !\(r\.miPuja && !cerrada\)/.test(js));
  assert.strictEqual((i18n.match(/\bm_sub_sigue:/g) || []).length, 2);
  assert.ok(/cuando falten 3 minutos/.test(i18n) && /when 3 minutes are left/.test(i18n));
});
