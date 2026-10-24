"use strict";
// "Socio desde" cuando la fecha del club no es confiable: no se muestra como hecho, la persona (o un admin) la corrige y nada la pisa.
const PUERTO_TUTI = 29891;   // distinto de club-mora (39883) y fuera del rango efímero
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.TUTI_API_HOST = `http://127.0.0.1:${PUERTO_TUTI}`;
process.env.TUTI_API_KEY = "falso";
process.env.TUTI_MERCHANT_KEY = "falso";
process.env.TUTI_PAUSA_MS = "0";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const ci = require("../lib/club-import");
const app = require("../server");
const { getStore } = require("../data/store");
const tuti = require("../lib/tuti");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

const HOY = Date.UTC(2026, 9, 24);
const d = (s) => new Date(s + "T00:00:00Z");
const fila = (o = {}) => ({
  "Nombre SN": "JUAN PEREZ", "Número de identificación fiscal": 1234567, "Nombre de grupo": "PERSONAL", "Numero Socio": 100, "Fecha ingreso Socio": d("2014-05-10"),
  Activo: "Y", Fecha_Nacimiento: d("1985-03-02"), "Año Primer Registro Cuota": 2017, "Meses Pagados por Cuotas": 24, "Antigüedad Total (Años)": 5, ...o,
});
const una = (o) => ci.procesarFilas([fila(o)], { hoy: HOY }).registros[0];

test("VITALICIO: no hay 'Socio desde' ni se usa el año de la primera cuota (el club cargó fechas que no son reales)", () => {
  const r = una({ "Nombre de grupo": "VITALICIO", "Fecha ingreso Socio": d("2001-08-26"), "Año Primer Registro Cuota": 2001 });
  assert.strictEqual(r.socio_desde, null);
  assert.strictEqual(r.antig_anios, null);
  assert.strictEqual(r.fecha_fuente, "dudosa");
  assert.strictEqual(r.dudosa, undefined, "el marcador interno no se guarda");
  assert.strictEqual(r.nro_socio, "100", "el número de socio sí se conserva");
});

test("VITALICIO sin fecha de ingreso (la fecha cero) también queda sin fecha, aunque haya año de primera cuota", () => {
  const r = una({ "Nombre de grupo": "VITALICIO", "Fecha ingreso Socio": d("1899-12-31"), "Año Primer Registro Cuota": 2005 });
  assert.deepStrictEqual([r.socio_desde, r.fecha_fuente], [null, "dudosa"]);
});

test("ingreso antes de nacer o con el nacimiento como fecha: dudosa", () => {
  assert.strictEqual(una({ "Fecha ingreso Socio": d("1980-01-01") }).fecha_fuente, "dudosa", "antes de nacer");
  assert.strictEqual(una({ "Fecha ingreso Socio": d("1985-03-02") }).fecha_fuente, "dudosa", "el día del nacimiento");
  assert.strictEqual(una({ "Fecha ingreso Socio": d("1985-09-01") }).fecha_fuente, "dudosa", "a los 6 meses de vida");
});

test("ingreso con 14 años o menos: dudoso en grupos de adultos, normal en grupos de menores", () => {
  assert.strictEqual(una({ "Fecha ingreso Socio": d("1998-01-01") }).fecha_fuente, "dudosa", "PERSONAL con 12 años");
  for (const grupo of ["CADETE", "INFANTIL", "FAMILIAR"]) assert.strictEqual(una({ "Nombre de grupo": grupo, "Fecha ingreso Socio": d("1998-01-01") }).fecha_fuente, "ingreso", grupo);
  assert.strictEqual(una({ "Fecha ingreso Socio": d("2000-06-01") }).fecha_fuente, "ingreso", "15 años: creíble");
});

test("sin nacimiento conocido no se sospecha por la edad: la fecha del club se usa", () => {
  const r = una({ Fecha_Nacimiento: d("1899-12-31") });
  assert.deepStrictEqual([r.socio_desde, r.fecha_fuente], ["2014-05-10", "ingreso"]);
});

test("una fila normal sigue igual", () => {
  const r = una();
  assert.deepStrictEqual([r.socio_desde, r.fecha_fuente], ["2014-05-10", "ingreso"]);
});

test("esDudosa se exporta y no marca a quien no tiene fecha utilizable (ahí manda la cadena de respaldo)", () => {
  assert.strictEqual(ci.esDudosa({ grupo: "PERSONAL", ingreso: null, nacimiento: "1985-03-02", utilizable: false }), false);
  assert.strictEqual(ci.esDudosa({ grupo: "VITALICIO", ingreso: null, nacimiento: null, utilizable: false }), true);
});

// ── De punta a punta (memoria) ──
let srv, url, club;
before(async () => {
  club = await new Promise((res) => { const s = http.createServer((req, rs) => {
    const doc = new URL(req.url, "http://x").searchParams.get("documentNumber") || "";
    rs.setHeader("Content-Type", "application/json");
    rs.end(JSON.stringify({ documentNumber: doc, documentType: "CI", firstName: "X", lastName: "Y", subscriptionNumber: 9001, plan: "Socio Pleno", autoDebitEnabled: false, debtor: false, totalDebt: 0, status: "ACTIVE" }));
  }).listen(PUERTO_TUTI, () => res(s)); });
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv && srv.close(); club && club.close(); });
beforeEach(() => tuti.__resetBloqueo());

const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const ADM = { "x-admin-key": "clave-admin-de-prueba" };
let n = 0;
async function cuenta() {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `sd${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Prueba" } });
  const { token, socio } = await r.json();
  return { id: socio.id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}
const reg = (cedula, extra = {}) => ({ cedula, grupo: "VITALICIO", nro_socio: "1790", socio_desde: null, fecha_calidad: "creible", fecha_fuente: "dudosa", antig_anios: null, meses_pagados: 0, activo_erp: true, nombre: "Eduardo Prueba", correo: "", telefono: "", nacimiento: null, ...extra });

test("validar con una fila dudosa: es socio, conserva el número, pero NO se inventa un 'Socio desde'", async () => {
  await store.upsertSociosClub([reg("8300001")]);
  const A = await cuenta();
  const r = await (await api("/perfil/validar-socio", { metodo: "POST", h: A.h, cuerpo: { cedula: "8300001" } })).json();
  assert.strictEqual(r.validado, true);
  const s = await store.getSocioById(A.id);
  assert.deepStrictEqual({ socio: s.es_socio_olimpia, nro: s.nro_socio, desde: s.socio_desde || null }, { socio: true, nro: "1790", desde: null });
  const c = (await (await api("/carnet", { h: A.h })).json()).carnet;
  assert.deepStrictEqual({ esSocio: c.esSocio, socioDesde: c.socioDesde, nroSocio: c.nroSocio }, { esSocio: true, socioDesde: "", nroSocio: "1790" });
  const h = await (await api("/historia", { h: A.h })).json();
  assert.strictEqual(h.socio_desde, "");
  assert.strictEqual(h.anios_socio, null);
});

test("el socio cuenta su año: queda en el carnet y la historia como declarado, y la base del club no lo pisa", async () => {
  await store.upsertSociosClub([reg("8300011")]);
  const A = await cuenta();
  await api("/perfil/validar-socio", { metodo: "POST", h: A.h, cuerpo: { cedula: "8300011" } });
  const r = await api("/socio-desde", { metodo: "POST", h: A.h, cuerpo: { anio: 2008 } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), { ok: true, socio_desde: "2008-01-01", socio_desde_fuente: "declarada" });
  const c = (await (await api("/carnet", { h: A.h })).json()).carnet;
  assert.deepStrictEqual([c.socioDesde, c.socioDesdeFuente], ["2008-01-01", "declarada"]);
  const h = await (await api("/historia", { h: A.h })).json();
  assert.deepStrictEqual([h.socio_desde, h.socio_desde_fuente, h.anios_socio >= 18], ["2008-01-01", "declarada", true]);
  // aunque la base del club diga otra cosa (o se vuelva a importar), la declarada manda
  await store.upsertSociosClub([reg("8300011", { fecha_fuente: "ingreso", socio_desde: "2001-08-26" })]);
  await store.completarSociosDesdeClub();
  assert.strictEqual(String((await store.getSocioById(A.id)).socio_desde).slice(0, 10), "2008-01-01");
});

test("el año declarado se valida, y solo lo puede declarar un socio del club", async () => {
  const noSocio = await cuenta();
  assert.strictEqual((await api("/socio-desde", { metodo: "POST", h: noSocio.h, cuerpo: { anio: 2008 } })).status, 403);
  await store.upsertSociosClub([reg("8300021")]);
  const A = await cuenta();
  await api("/perfil/validar-socio", { metodo: "POST", h: A.h, cuerpo: { cedula: "8300021" } });
  for (const anio of [1949, 2999, "abc", 2008.5, null, undefined]) assert.strictEqual((await api("/socio-desde", { metodo: "POST", h: A.h, cuerpo: { anio } })).status, 400, String(anio));
  assert.strictEqual((await api("/socio-desde", { metodo: "POST", cuerpo: { anio: 2008 } })).status, 401, "sin sesión");
  assert.strictEqual(String((await store.getSocioById(A.id)).socio_desde || ""), "", "nada se guardó");
});

test("completar desde el club: una fecha puesta por el sistema se quita si la fila resulta dudosa; la declarada o la de un admin no se toca", async () => {
  await store.upsertSociosClub([reg("8300031"), reg("8300032"), reg("8300033")]);
  const mk = async (ced, extra) => { const a = await cuenta(); await store.updateSocio(a.id, { cedula: ced, es_socio_olimpia: true, ...extra }); return a.id; };
  const sistema = await mk("8300031", { socio_desde: "2001-08-26", socio_desde_fuente: "" });
  const declarada = await mk("8300032", { socio_desde: "2008-01-01", socio_desde_fuente: "declarada" });
  const admin = await mk("8300033", { socio_desde: "2010-05-05", socio_desde_fuente: "admin" });
  const r = await store.completarSociosDesdeClub();
  assert.ok(r.dudosas_quitadas >= 1);
  const f = async (id) => String((await store.getSocioById(id)).socio_desde || "").slice(0, 10);
  assert.deepStrictEqual([await f(sistema), await f(declarada), await f(admin)], ["", "2008-01-01", "2010-05-05"]);
});

test("completar desde el club: a una cuenta dudosa no se le inventa la fecha de la membresía", async () => {
  await store.upsertSociosClub([reg("8300041")]);
  const A = await cuenta();
  await store.updateSocio(A.id, { cedula: "8300041", es_socio_olimpia: true });
  await store.setMembresia(A.id, { tierSlug: "socio", ciclo: "anio", pagoRef: "socio:t" });
  await store.completarSociosDesdeClub();
  assert.strictEqual(String((await store.getSocioById(A.id)).socio_desde || ""), "");
});

test("admin: fija 'Socio desde' desde la ficha (queda como admin), lo valida y puede vaciarlo", async () => {
  const A = await cuenta();
  await store.updateSocio(A.id, { es_socio_olimpia: true });
  const patch = (cuerpo) => api("/admin/socios/" + A.id, { metodo: "PATCH", h: ADM, cuerpo });
  for (const malo of ["2008", "31/12/2008", "2008-02-31", "1949-12-31", "2999-01-01", "ayer"]) assert.strictEqual((await patch({ socio_desde: malo })).status, 400, malo);
  const ok = await (await patch({ socio_desde: "2009-04-03" })).json();
  assert.deepStrictEqual([String(ok.socio.socio_desde).slice(0, 10), ok.socio.socio_desde_fuente], ["2009-04-03", "admin"]);
  const fic = await (await api("/admin/socios/" + A.id, { h: ADM })).json();
  assert.strictEqual(fic.socio.socio_desde_fuente, "admin");
  const vacio = await (await patch({ socio_desde: "" })).json();
  assert.deepStrictEqual([vacio.socio.socio_desde || null, vacio.socio.socio_desde_fuente], [null, ""]);
});

test("el carnet y la historia piden la fecha en vez de mostrar una inventada, y muestran solo el año cuando no hay día", () => {
  const j = leer("public", "js", "socio.js"), i = leer("public", "js", "i18n.js"), a = leer("public", "admin.html");
  assert.ok(/data-sd-declarar/.test(j) && /function socioDesdeModal/.test(j) && /\/socio-desde/.test(j));
  assert.ok(/const fechaSocio = \(d\) => \(\/-01-01\$\/\.test\(d\)/.test(j), "1 de enero = solo año");
  assert.ok(/accion: "carnet"/.test(j), "el carnet sin fecha ofrece contarla");
  for (const k of ["sd_falta", "sd_corregir", "sd_h", "sd_p", "sd_ph", "sd_guardar", "sd_err", "sd_ok", "sd_declarado"]) assert.strictEqual((i.match(new RegExp("\\b" + k + ":", "g")) || []).length, 2, k + " en es y en");
  assert.ok(/id="fDesde"/.test(a) && /body\.socio_desde = fd\.value/.test(a), "la ficha del admin permite fijarla");
});
