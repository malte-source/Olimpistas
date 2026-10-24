"use strict";
// Validación de socio automática (cédula → consulta al club en el momento) y antigüedad REAL en el carnet.
const PUERTO_TUTI = 39881;
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.TUTI_API_HOST = `http://127.0.0.1:${PUERTO_TUTI}`;
process.env.TUTI_API_KEY = "falso";
process.env.TUTI_MERCHANT_KEY = "falso";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

const app = require("../server");
const { getStore } = require("../data/store");
const tuti = require("../lib/tuti");
const { aFecha } = require("../setup/cargar-antiguedad");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url, club, consultas = 0;
before(async () => {
  // Club falso: la cédula que termina en 1 es socia (con fecha de alta), la que termina en 4 está dada de baja, el resto no figura.
  club = await new Promise((res) => { const s = http.createServer((req, rs) => {
    consultas++;
    const doc = new URL(req.url, "http://x").searchParams.get("documentNumber") || "";
    const base = { documentNumber: doc, documentType: "CI", firstName: "X", lastName: "Y", subscriptionNumber: 4321, plan: "Socio Pleno", autoDebitEnabled: false, debtor: false, totalDebt: 0 };
    rs.setHeader("Content-Type", "application/json");
    if (doc.endsWith("1")) return rs.end(JSON.stringify({ ...base, status: "ACTIVE", subscriptionDate: "2009-03-14T00:00:00Z" }));
    if (doc.endsWith("2")) return rs.end(JSON.stringify({ ...base, status: "ACTIVE" }));        // socio sin fecha de alta
    if (doc.endsWith("4")) return rs.end(JSON.stringify({ ...base, status: "UNSUBSCRIBED" }));
    rs.statusCode = 404; rs.end(JSON.stringify({ errors: [{ code: "SUB-027" }] }));
  }).listen(PUERTO_TUTI, () => res(s)); });
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv && srv.close(); club && club.close(); });
beforeEach(() => { tuti.__resetBloqueo(); consultas = 0; });

const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function hincha(extra = {}) {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `va${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Prueba" } });
  const { token, socio: s } = await r.json();
  if (Object.keys(extra).length) await store.updateSocio(s.id, extra);
  return { id: s.id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}

test("la cédula de un socio al día valida en el momento y guarda su antigüedad real y su número de socio", async () => {
  const A = await hincha();
  const r = await (await api("/perfil/validar-socio", { metodo: "POST", h: A.h, cuerpo: { cedula: "7000001" } })).json();
  assert.strictEqual(r.validado, true);
  assert.strictEqual(r.estado, "validado_auto");
  const s = await store.getSocioById(A.id);
  assert.strictEqual(String(s.socio_desde).slice(0, 10), "2009-03-14");
  assert.strictEqual(s.nro_socio, "4321");
  const c = (await (await api("/carnet", { h: A.h })).json()).carnet;
  assert.deepStrictEqual({ esSocio: c.esSocio, socioDesde: c.socioDesde, nroSocio: c.nroSocio }, { esSocio: true, socioDesde: "2009-03-14", nroSocio: "4321" });
});

test("un socio sin fecha de alta en el club igual tiene su antigüedad definida: cuenta desde el día en que se lo reconoce (y trae su número de socio)", async () => {
  const A = await hincha();
  assert.strictEqual((await (await api("/perfil/validar-socio", { metodo: "POST", h: A.h, cuerpo: { cedula: "7000002" } })).json()).validado, true);
  const c = (await (await api("/carnet", { h: A.h })).json()).carnet;
  assert.strictEqual(c.socioDesde, new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10), "sin dato del club, la antigüedad cuenta desde hoy (hora de Paraguay)");
  assert.strictEqual(c.nroSocio, "4321");
  const sj = leer("public", "js", "socio.js");
  assert.match(sj, /if \(c\.socioDesde\) filas\.push\(\{ et: T\("cn_socio_desde"\), val: fechaMes\(c\.socioDesde\) \+ textoAnios\(aniosDeSocio\(c\.socioDesde\)\) \}\);\s*else if \(c\.nroSocio\) filas\.push\(\{ et: T\("cn_nro_socio"\)/);
  assert.match(sj, /const filas = \[\{ et: T\("m_cn_desde"\), val: desdeOlimpistas \}\]/, "siempre se muestra desde cuándo es miembro de Olimpistas");
});

test("quien no es socio ve desde cuándo es hincha de Olimpistas, no una antigüedad de socio", async () => {
  const A = await hincha();
  await api("/perfil/validar-socio", { metodo: "POST", h: A.h, cuerpo: { cedula: "7000004" } });   // baja: no valida
  const c = (await (await api("/carnet", { h: A.h })).json()).carnet;
  assert.deepStrictEqual({ esSocio: c.esSocio, socioDesde: c.socioDesde, nroSocio: c.nroSocio }, { esSocio: false, socioDesde: "", nroSocio: "" });
});

test("reintento silencioso: usa la cédula de la cuenta, valida sola a quien ya se puso al día y no deja reclamos ni mails si sigue sin figurar", async () => {
  const B = await hincha({ cedula: "7000009" });                 // no figura en el club
  const sin = await (await api("/perfil/validar-socio", { metodo: "POST", h: B.h, cuerpo: { silencioso: true } })).json();
  assert.strictEqual(sin.validado, false);
  assert.strictEqual((await store.listActualizaciones({ socioId: B.id, tipo: "socio_claim" })).length, 0, "el reintento automático no llena la bandeja");
  const otra = await (await api("/perfil/validar-socio", { metodo: "POST", h: B.h, cuerpo: { silencioso: true } })).json();
  assert.strictEqual(otra.omitido, true, "no se vuelve a consultar al club antes de 6 h");

  const A = await hincha({ cedula: "7000011" });                 // ya es socia al día en el club
  const r = await (await api("/perfil/validar-socio", { metodo: "POST", h: A.h, cuerpo: { silencioso: true } })).json();
  assert.strictEqual(r.validado, true);
  assert.strictEqual((await store.getSocioById(A.id)).es_socio_olimpia, true);
  const ya = await (await api("/perfil/validar-socio", { metodo: "POST", h: A.h, cuerpo: { silencioso: true } })).json();
  assert.strictEqual(ya.omitido, true, "si ya es socio no se consulta");

  const C = await hincha();                                      // sin cédula en la cuenta: nada que reintentar
  assert.strictEqual((await (await api("/perfil/validar-socio", { metodo: "POST", h: C.h, cuerpo: { silencioso: true } })).json()).omitido, true);
});

test("tuti: toma la fecha de alta si la API la trae y descarta fechas inválidas o futuras", async () => {
  assert.strictEqual(tuti.fechaAlta("2014-03-09T00:00:00Z"), "2014-03-09");
  assert.strictEqual(tuti.fechaAlta("1850-01-01"), "");
  assert.strictEqual(tuti.fechaAlta("2999-01-01"), "");
  assert.strictEqual(tuti.fechaAlta("ayer"), "");
  assert.strictEqual(tuti.fechaAlta(undefined), "");
});

test("cargar-antiguedad: entiende fechas de Excel, dd/mm/aaaa y aaaa-mm-dd y descarta las inválidas", () => {
  assert.strictEqual(aFecha("14/03/2009"), "2009-03-14");
  assert.strictEqual(aFecha("2009-03-14"), "2009-03-14");
  assert.strictEqual(aFecha(new Date(Date.UTC(2009, 2, 14))), "2009-03-14");
  assert.strictEqual(aFecha(39873), "2009-03-01");           // número de serie de Excel
  assert.strictEqual(aFecha("31/02/20"), "");
  assert.strictEqual(aFecha("01/01/2999"), "");
  assert.strictEqual(aFecha(""), "");
});

test("pantalla: el modal consulta al club en el momento, explica si no figura y la app reintenta sola al abrir", () => {
  const sj = leer("public", "js", "socio.js");
  assert.match(sj, /btn\.textContent = T\("up_consultando"\)/);
  assert.match(sj, /T\("up_no_h"\)/);
  assert.match(sj, /async function revalidarSocioSilencioso\(\)/);
  assert.match(sj, /body: \{ silencioso: true \}/);
  const i = leer("public", "js", "i18n.js");
  for (const k of ["up_consultando", "up_no_h", "up_no_p", "up_otra", "up_persona", "cn_socio_desde", "cn_nro_socio"]) assert.ok(i.split(" " + k + ":").length - 1 >= 2, k);
});

test("migración 0014: columnas de antigüedad, aditiva", () => {
  const m = leer("migraciones", "0014_socio_antiguedad.sql");
  assert.match(m, /ALTER TABLE public\.socios ADD COLUMN IF NOT EXISTS socio_desde date/);
  assert.match(m, /ALTER TABLE public\.padron_olimpia ADD COLUMN IF NOT EXISTS socio_desde date/);
  assert.ok(!/DROP|DELETE|TRUNCATE/i.test(m));
});
