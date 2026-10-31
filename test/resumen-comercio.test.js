"use strict";
// P15 · Resumen mensual al comercio: el día 1 (o 2 o 3) cada comercio activo con correo y algo para contar recibe cómo le fue el mes pasado, una sola vez.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CORREO_RESPIRO_MS = "0";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const mailer = require("../lib/email");
const lib = require("../lib/resumen-comercio");
const enviarReal = mailer.enviarResumenComercio;   // antes de que cada test la reemplace por un espía
const { getStore } = require("../data/store");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url, envios;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
beforeEach(() => { envios = []; mailer.enviarResumenComercio = async (d, r) => { envios.push({ a: d.email, r }); return { ok: true, modo: "resend" }; }; });
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const ADM = { "x-admin-key": "clave-admin-de-prueba" };
let n = 0;
const mes = (anio, m1, dia, hora = 15) => new Date(Date.UTC(anio, m1 - 1, dia, hora)).toISOString();
async function canje(comercioId, creado, { ahorro = 10000, monto = 100000, tier = "olimpista" } = {}) {
  const c = await store.registrarCanje({ beneficioId: "ben_x", socioId: "soc_x", comercioId, validadoPor: "t", monto, ahorro, tierSlug: tier });
  c.creado = creado; c.tier_slug = tier; // memory-store devuelve la referencia: se reubica en el tiempo y se le pone el nivel
  return c;
}
const comercio = (extra = {}) => store.crearComercio({ nombre: "Comercio " + (++n), ciudad: "Asunción", contacto: `res${n}-${Date.now()}@ejemplo.com`, ...extra });
const oferta = (c, extra = {}) => store.crearBeneficio({ comercio_id: c.id, titulo: "10 % en todo", valor: "10%", niveles: "todos", ...extra });

test("los límites del mes son en hora de Paraguay (UTC-3) y el mes anterior cruza el año", () => {
  assert.deepStrictEqual(lib.limitesMes(2026, 9), { desde: "2026-10-01T03:00:00.000Z", hasta: "2026-11-01T03:00:00.000Z" });
  assert.deepStrictEqual(lib.limitesMes(2026, 11), { desde: "2026-12-01T03:00:00.000Z", hasta: "2027-01-01T03:00:00.000Z" });
  assert.deepStrictEqual([lib.mesAnterior("2026-11-01").clave, lib.mesAnterior("2026-11-01").nombre, lib.mesAnterior("2026-11-01").etiqueta], ["2026-10", "octubre", "octubre de 2026"]);
  assert.deepStrictEqual([lib.mesAnterior("2027-01-02").clave, lib.mesAnterior("2027-01-02").etiqueta], ["2026-12", "diciembre de 2026"]);
});

test("las cifras: canjes, ahorro, ventas y mezcla del mes contra el mes anterior; un canje de la madrugada del día 1 (hora local) cuenta en el mes que cierra", async () => {
  const c = await comercio();
  await canje(c.id, mes(2026, 10, 5), { ahorro: 10000, monto: 100000, tier: "premium" });
  await canje(c.id, mes(2026, 10, 20), { ahorro: 20000, monto: 300000, tier: "premium" });
  await canje(c.id, mes(2026, 10, 31, 20), { ahorro: 5000, monto: 50000, tier: "socio" });       // 17:00 del 31 en Paraguay: octubre
  await canje(c.id, mes(2026, 11, 1, 2), { ahorro: 7000, monto: 70000 });                         // 23:00 del 31 en Paraguay: octubre
  await canje(c.id, mes(2026, 11, 1, 4), { ahorro: 9999, monto: 99999 });                         // 01:00 del 1 en Paraguay: noviembre, no entra
  await canje(c.id, mes(2026, 9, 10), { ahorro: 1000, monto: 10000 });
  const r = await lib.armarResumen({ store, comercio: c, mes: lib.mesAnterior("2026-11-01"), hoyPy: "2026-11-01", beneficios: [] });
  assert.deepStrictEqual([r.actual.canjes, r.actual.ahorro, r.actual.ventas, r.actual.ticket_promedio], [4, 42000, 520000, 130000]);
  assert.deepStrictEqual(r.actual.mix.map((m) => [m.nivel, m.canjes]).sort(), [["olimpista", 1], ["premium", 2], ["socio", 1]]);
  assert.deepStrictEqual([r.anterior.canjes, r.anterior.ahorro], [1, 1000]);
  assert.strictEqual(r.mesPrevio.nombre, "septiembre");
});

test("las ofertas: activas y las que vencen en los próximos 30 días; no las vencidas, las pausadas ni las sin aprobar", async () => {
  const c = await comercio(), otro = await comercio();
  await oferta(c, { titulo: "Sin vencimiento" });
  await oferta(c, { titulo: "Vence pronto", vigencia_hasta: "2026-11-20" });
  await oferta(c, { titulo: "Vence lejos", vigencia_hasta: "2027-03-01" });
  await oferta(c, { titulo: "Ya venció", vigencia_hasta: "2026-10-01" });
  await oferta(c, { titulo: "Pausada", activo: false, vigencia_hasta: "2026-11-10" });
  await oferta(otro, { titulo: "De otro comercio", vigencia_hasta: "2026-11-05" });
  const r = await lib.armarResumen({ store, comercio: c, mes: lib.mesAnterior("2026-11-01"), hoyPy: "2026-11-01", beneficios: await store.listBeneficios() });
  assert.strictEqual(r.activas, 3);
  assert.deepStrictEqual(r.vencen.map((v) => [v.titulo, v.texto]), [["Vence pronto", "20 de noviembre"]]);
});

test("envío del día 1: a cada comercio activo con correo y algo para contar, una sola vez por mes; solo los días 1 a 3", async () => {
  const conCanjes = await comercio(), soloOferta = await comercio(), vacio = await comercio(), sinCorreo = await comercio({ contacto: "" }), pausado = await comercio({ estado: "pausado" });
  await canje(conCanjes.id, mes(2026, 10, 12));
  await canje(sinCorreo.id, mes(2026, 10, 12)); await canje(pausado.id, mes(2026, 10, 12));
  await oferta(soloOferta);
  const mis = new Set([conCanjes.contacto, soloOferta.contacto]);
  const out = await lib.enviarResumenesMensuales({ store, mailer, hoyPy: "2026-11-01", pausaMs: 0 });
  const mios = envios.filter((e) => mis.has(e.a));
  assert.deepStrictEqual(mios.map((e) => e.a).sort(), [...mis].sort());
  assert.ok(!envios.some((e) => [vacio.contacto, pausado.contacto].includes(e.a)), "sin nada para contar o pausado: no se escribe");
  assert.ok(out.enviados >= 2);
  assert.strictEqual(mios.find((e) => e.a === conCanjes.contacto).r.actual.canjes, 1);
  // repetir el mismo día, o el día 2 o 3, no vuelve a mandar
  const antes = envios.length;
  await lib.enviarResumenesMensuales({ store, mailer, hoyPy: "2026-11-01", pausaMs: 0 });
  await lib.enviarResumenesMensuales({ store, mailer, hoyPy: "2026-11-03", pausaMs: 0 });
  assert.strictEqual(envios.length, antes);
  // a mitad de mes no se manda; el mes siguiente sí
  assert.strictEqual((await lib.enviarResumenesMensuales({ store, mailer, hoyPy: "2026-11-15", pausaMs: 0 })).fuera_de_fecha, true);
  assert.strictEqual(envios.length, antes);
  await lib.enviarResumenesMensuales({ store, mailer, hoyPy: "2026-12-02", pausaMs: 0 });
  assert.ok(envios.filter((e) => e.a === soloOferta.contacto).length === 2, "diciembre: resumen de noviembre");
});

test("un correo que falla se cuenta como error y no frena a los demás", async () => {
  const a = await comercio(), b = await comercio();
  await oferta(a); await oferta(b);
  mailer.enviarResumenComercio = async (d) => { envios.push({ a: d.email }); return d.email === a.contacto ? { ok: false } : { ok: true }; };
  const out = await lib.enviarResumenesMensuales({ store, mailer, hoyPy: "2027-02-01", pausaMs: 0 });
  assert.ok(out.errores >= 1 && envios.some((e) => e.a === b.contacto));
});

test("el correo real se arma sin romper con y sin datos (modo simulado, sin Resend)", async () => {
  const c = await comercio();
  const vacio = await lib.armarResumen({ store, comercio: c, mes: lib.mesAnterior("2027-03-01"), hoyPy: "2027-03-01", beneficios: [] });
  const real = enviarReal;
  assert.strictEqual(typeof real, "function");
  assert.strictEqual((await real({ email: "x@ejemplo.com" }, vacio)).ok, true);
  await canje(c.id, mes(2027, 2, 10), { ahorro: 5000, monto: 50000, tier: "premium" });
  const lleno = await lib.armarResumen({ store, comercio: c, mes: lib.mesAnterior("2027-03-01"), hoyPy: "2027-03-01", beneficios: [{ comercio_id: c.id, titulo: "2x1 <b>", estado: "aprobado", vigencia_hasta: "2027-03-10" }] });
  assert.strictEqual((await real({ email: "x@ejemplo.com" }, { ...lleno, vistaPrevia: true })).ok, true);
});

test("admin: vista previa a un correo propio (no consume el envío del mes) o envío al comercio; con permisos y validaciones", async () => {
  const c = await comercio(), sin = await comercio({ contacto: "" });
  await canje(c.id, mes(2026, 10, 12));
  assert.strictEqual((await api("/admin/comercios/" + c.id + "/resumen-mensual", { metodo: "POST", cuerpo: {} })).status, 401);
  assert.strictEqual((await api("/admin/comercios/com_inventado/resumen-mensual", { metodo: "POST", h: ADM, cuerpo: {} })).status, 404);
  assert.strictEqual((await api("/admin/comercios/" + c.id + "/resumen-mensual", { metodo: "POST", h: ADM, cuerpo: { a: "no-es-un-correo" } })).status, 400);
  assert.strictEqual((await api("/admin/comercios/" + sin.id + "/resumen-mensual", { metodo: "POST", h: ADM, cuerpo: {} })).status, 409);
  const prev = await (await api("/admin/comercios/" + c.id + "/resumen-mensual", { metodo: "POST", h: ADM, cuerpo: { a: "malte@ejemplo.com" } })).json();
  assert.deepStrictEqual([prev.ok, prev.enviado_a, prev.vista_previa], [true, "malte@ejemplo.com", true]);
  assert.strictEqual(envios.at(-1).a, "malte@ejemplo.com");
  assert.strictEqual(envios.at(-1).r.vistaPrevia, true);
  const real = await (await api("/admin/comercios/" + c.id + "/resumen-mensual", { metodo: "POST", h: ADM, cuerpo: {} })).json();
  assert.deepStrictEqual([real.enviado_a, real.vista_previa], [c.contacto, false]);
  assert.strictEqual(envios.at(-1).r.vistaPrevia, false);
});

test("pantallas y cron: botón Resumen en Comercios del panel y paso en el cron diario", () => {
  const ad = leer("public", "admin.html"), rt = leer("routes.js"), em = leer("lib", "email.js");
  assert.ok(/data-comresumen/.test(ad) && /resumen-mensual/.test(ad) && /Enviarme la vista previa/.test(ad));
  assert.ok(/resumenComercioLib\.enviarResumenesMensuales/.test(rt));
  assert.ok(/async function enviarResumenComercio/.test(em) && /enviarResumenComercio,/.test(em));
});
