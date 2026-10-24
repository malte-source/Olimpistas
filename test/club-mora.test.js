"use strict";
// Validación automática: al día → se activa solo; en mora → se le pide pagar en el portal y se revisa de nuevo (a mano y solo); baja; API caída;
// el detalle solo se muestra si la cuenta coincide con la persona del club; "Socio desde" siempre definido; perfiles de la campaña.
const PUERTO_TUTI = 39883;
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";
process.env.TUTI_API_HOST = `http://127.0.0.1:${PUERTO_TUTI}`;
process.env.TUTI_API_KEY = "falso";
process.env.TUTI_MERCHANT_KEY = "falso";
process.env.TUTI_PAUSA_MS = "0";
process.env.TUTI_LOTE = "1";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const app = require("../server");
const { getStore } = require("../data/store");
const tuti = require("../lib/tuti");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

// API falsa del club: el estado de cada cédula se puede cambiar desde el test ("paga" → ACTIVE).
const estado = {};   // cédula → "ACTIVE" | "DEBT" | "UNSUBSCRIBED" | "CAIDA" | (sin dato → 404)
let srv, url, club, consultas = [];
before(async () => {
  club = await new Promise((res) => { const s = http.createServer((req, rs) => {
    const doc = new URL(req.url, "http://x").searchParams.get("documentNumber") || ""; consultas.push(doc);
    rs.setHeader("Content-Type", "application/json");
    const st = estado[doc];
    if (st === "CAIDA") { rs.statusCode = 500; return rs.end("{}"); }
    if (!st) { rs.statusCode = 404; return rs.end(JSON.stringify({ errors: [{ code: "SUB-027" }] })); }
    rs.end(JSON.stringify({ documentNumber: doc, documentType: "CI", firstName: "Maria", lastName: "Gonzalez", email: `club${doc}@ejemplo.com`, subscriptionNumber: 4242, plan: "Socio Pleno", autoDebitEnabled: false,
      status: st, debtor: st === "DEBT", totalDebt: st === "DEBT" ? 180000 : 0 }));
  }).listen(PUERTO_TUTI, () => res(s)); });
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv && srv.close(); club && club.close(); });
beforeEach(() => { tuti.__resetBloqueo(); consultas = []; delete process.env.SOCIO_MORA; });

const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const validar = async (c, cuerpo) => (await api("/perfil/validar-socio", { metodo: "POST", h: c.h, cuerpo })).json();
let n = 0;
async function cuenta({ email, nombre = "Prueba", apellido = "Cuenta", confirmado = true } = {}) {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: email || `mo${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre, apellido } });
  const { token, socio } = await r.json();
  if (confirmado) await store.updateSocio(socio.id, { email_verificado: true });
  return { id: socio.id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}
const hoyPy = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

test("al día: se activa solo, y como la base no tiene fecha, su antigüedad queda definida desde hoy", async () => {
  estado["9100001"] = "ACTIVE";
  const A = await cuenta();
  const r = await validar(A, { cedula: "9100001" });
  assert.deepStrictEqual({ v: r.validado, e: r.estado }, { v: true, e: "validado_auto" });
  const s = await store.getSocioById(A.id);
  assert.deepStrictEqual({ socio: s.es_socio_olimpia, club: s.club_estado, desde: String(s.socio_desde).slice(0, 10), nro: s.nro_socio }, { socio: true, club: "al_dia", desde: hoyPy(), nro: "4242" });
});

test("en mora con el correo del club: se le dice cuánto debe y se lo manda al portal; no se activa", async () => {
  estado["9200001"] = "DEBT";
  const A = await cuenta({ email: "club9200001@ejemplo.com" });
  const r = await validar(A, { cedula: "9200001" });
  assert.deepStrictEqual({ v: r.validado, e: r.estado, deuda: r.deuda }, { v: false, e: "mora", deuda: 180000 });
  assert.match(r.portal, /^https:\/\/socios\.clubolimpia\.com\.py/);
  const s = await store.getSocioById(A.id);
  assert.deepStrictEqual({ socio: s.es_socio_olimpia, club: s.club_estado, deuda: s.club_deuda }, { socio: false, club: "mora", deuda: 180000 });
});

test("en mora y solo coincide el nombre: se le avisa de la cuota pendiente pero sin el monto", async () => {
  estado["9300001"] = "DEBT";
  const A = await cuenta({ nombre: "María", apellido: "González" });
  const r = await validar(A, { cedula: "9300001" });
  assert.deepStrictEqual({ e: r.estado, deuda: r.deuda }, { e: "mora", deuda: null });
  assert.strictEqual((await store.getSocioById(A.id)).club_deuda, null);
});

test("quien prueba una cédula ajena (nada coincide) recibe la misma respuesta neutra que si no figurara: no se filtra el estado de pago", async () => {
  estado["9400001"] = "DEBT"; estado["9400002"] = "UNSUBSCRIBED";
  const A = await cuenta({ nombre: "Pedro", apellido: "Lopez" });
  const B = await cuenta({ nombre: "Pedro", apellido: "Lopez" });
  const mora = await validar(A, { cedula: "9400001" }), baja = await validar(B, { cedula: "9400002" });
  assert.deepStrictEqual([mora.estado, baja.estado], ["a_revisar", "a_revisar"]);
  assert.ok(!("deuda" in mora) && !("portal" in mora));
  const sA = await store.getSocioById(A.id);
  assert.deepStrictEqual({ club: sA.club_estado, deuda: sA.club_deuda }, { club: "revision", deuda: null }, "ni siquiera queda guardado en la cuenta (se ve en /auth/yo)");
  const yo = await (await api("/auth/yo", { h: A.h })).json();
  assert.ok(!/mora/.test(JSON.stringify(yo)));
});

test("baja: si la cuenta coincide, se le ofrece reactivar en el portal", async () => {
  estado["9500001"] = "UNSUBSCRIBED";
  const A = await cuenta({ email: "club9500001@ejemplo.com" });
  const r = await validar(A, { cedula: "9500001" });
  assert.deepStrictEqual({ v: r.validado, e: r.estado }, { v: false, e: "baja" });
  assert.ok(r.portal);
  assert.strictEqual((await store.getSocioById(A.id)).es_socio_olimpia, false);
});

test("'Ya pagué, revisar': vuelve a consultar al club en vivo y, si ya está al día, se activa; con tope de una consulta por minuto", async () => {
  estado["9600001"] = "DEBT";
  const A = await cuenta({ email: "club9600001@ejemplo.com" });
  assert.strictEqual((await validar(A, { cedula: "9600001" })).estado, "mora");
  consultas.length = 0;
  estado["9600001"] = "ACTIVE";                         // paga en el portal de socios
  const sinReintento = await validar(A, { cedula: "9600001" });
  assert.strictEqual(sinReintento.estado, "mora", "sin 'Ya pagué' se usa lo guardado hace menos de una hora");
  assert.deepStrictEqual(consultas, []);
  const r = await validar(A, { reintentar: true });     // sin mandar la cédula: usa la de la cuenta
  assert.strictEqual(r.validado, true);
  assert.deepStrictEqual(consultas, ["9600001"], "una consulta en vivo");
  const s = await store.getSocioById(A.id);
  assert.deepStrictEqual({ socio: s.es_socio_olimpia, club: s.club_estado, deuda: s.club_deuda }, { socio: true, club: "al_dia", deuda: null });
  // tope: un segundo "Ya pagué" inmediato no vuelve a pegarle a la API
  estado["9600002"] = "DEBT";
  const B = await cuenta({ email: "club9600002@ejemplo.com" });
  await validar(B, { cedula: "9600002" });
  await validar(B, { reintentar: true });
  consultas.length = 0;
  await validar(B, { reintentar: true });
  assert.deepStrictEqual(consultas, [], "el segundo intento en el mismo minuto usa lo guardado");
});

test("el cron revisa solo a las cuentas en mora y, apenas el club dice 'al día', les activa el nivel Socio", async () => {
  estado["9700001"] = "DEBT";
  const A = await cuenta({ email: "club9700001@ejemplo.com" });
  assert.strictEqual((await validar(A, { cedula: "9700001" })).estado, "mora");
  await store.updateSocio(A.id, { club_consulta: new Date(Date.now() - 2 * 3600000).toISOString() });   // la última revisión fue hace 2 horas
  estado["9700001"] = "ACTIVE";
  const r = await (await api("/cron/horario", { metodo: "POST", h: { "x-cron-token": "secreto-de-cron-de-prueba" }, cuerpo: {} })).json();
  assert.deepStrictEqual({ rev: r.moras.revisadas >= 1, act: r.moras.activadas >= 1 }, { rev: true, act: true });
  assert.strictEqual((await store.getSocioById(A.id)).es_socio_olimpia, true);
  // una cuenta revisada hace poco no se vuelve a consultar
  estado["9700002"] = "DEBT";
  const B = await cuenta({ email: "club9700002@ejemplo.com" });
  await validar(B, { cedula: "9700002" });
  consultas.length = 0;
  await api("/cron/horario", { metodo: "POST", h: { "x-cron-token": "secreto-de-cron-de-prueba" }, cuerpo: {} });
  assert.ok(!consultas.includes("9700002"), "revisada hace menos de una hora");
});

test("API caída: 'reintentar', sin reclamo ni aviso de revisión y sin tocar el estado de la cuenta", async () => {
  estado["9800001"] = "CAIDA";
  const A = await cuenta();
  const r = await validar(A, { cedula: "9800001" });
  assert.deepStrictEqual({ v: r.validado, e: r.estado }, { v: false, e: "reintentar" });
  assert.strictEqual((await store.getSocioById(A.id)).club_estado || "", "");
  const reclamos = await store.listActualizaciones({ socioId: A.id, tipo: "socio_claim" });
  assert.strictEqual(reclamos.length, 0, "una API caída no genera trabajo para el equipo");
});

test("no figura: queda en revisión una sola vez (un reclamo y un aviso), no uno por intento", async () => {
  const A = await cuenta();
  assert.strictEqual((await validar(A, { cedula: "9900001" })).estado, "a_revisar");
  await validar(A, { cedula: "9900001" }); await validar(A, { cedula: "9900001" });
  await new Promise((x) => setTimeout(x, 80));
  assert.strictEqual((await store.listActualizaciones({ socioId: A.id, tipo: "socio_claim" })).length, 1);
  assert.strictEqual((await store.getSocioById(A.id)).club_estado, "revision");
});

test("SOCIO_MORA=permitir deja la mora como al día (decisión anterior del club)", async () => {
  process.env.SOCIO_MORA = "permitir";
  estado["9110001"] = "DEBT";
  const A = await cuenta();
  assert.strictEqual((await validar(A, { cedula: "9110001" })).validado, true);
});

test("perfiles de la campaña de validación: se guardan una sola vez y cuentan a quién alcanzarían", async () => {
  // por reconocer: cuenta con cédula que el club dice al día y todavía no es socia
  const P = await cuenta({ confirmado: false });
  await store.updateSocio(P.id, { cedula: "9120001" });
  await store.guardarEstadoTuti("9120001", { estado: "ACTIVE", alDia: true, deuda: 0 });
  // sin cédula con correo en la base
  const C = await cuenta({ email: "coincide-en-base@ejemplo.com", confirmado: false });
  assert.ok(C.id);
  await store.upsertSociosClub([{ cedula: "9120009", grupo: "PERSONAL", nro_socio: "", socio_desde: "2015-01-01", fecha_calidad: "creible", fecha_fuente: "ingreso", antig_anios: 11, meses_pagados: 0, activo_erp: true, nombre: "", correo: "coincide-en-base@ejemplo.com", telefono: "", nacimiento: null }]);
  const H = { "x-admin-key": "clave-admin-de-prueba" };
  const r1 = await (await api("/admin/club/perfiles", { metodo: "POST", h: H, cuerpo: {} })).json();
  assert.strictEqual(r1.creados.length, 3);
  const r2 = await (await api("/admin/club/perfiles", { metodo: "POST", h: H, cuerpo: {} })).json();
  assert.deepStrictEqual({ c: r2.creados.length, e: r2.existentes.length }, { c: 0, e: 3 }, "no duplica");
  const tot = Object.fromEntries(r1.perfiles.map((p) => [p.nombre.split("· ")[1], p.total]));
  assert.ok(tot["cuentas por reconocer"] >= 1 && tot["sin cédula, con correo en la base del club"] >= 1 && tot["socios en mora"] >= 1);
  const segs = await (await api("/admin/segmentos", { h: H })).json();
  const guardados = (segs.items || segs.segmentos || []).filter((x) => /^Validación de datos/.test(x.nombre));
  assert.strictEqual(guardados.length, 3);
  assert.deepStrictEqual(guardados.map((x) => Object.keys(x.filtros)[0]).sort(), ["candidataCorreo", "enMora", "porReconocer"]);
  assert.ok([401, 403].includes((await api("/admin/club/perfiles", { metodo: "POST", cuerpo: {} })).status));
  const res = await (await api("/admin/club/resumen", { h: H })).json();
  assert.strictEqual(res.perfiles.length, 3);
  assert.ok(typeof res.cuentas_en_mora === "number");
});

test("los socios ya reconocidos se completan con lo que sabe la base; sin fecha, cuentan desde que se los reconoció", async () => {
  const A = await cuenta(), B = await cuenta();
  await store.updateSocio(A.id, { cedula: "9130001", es_socio_olimpia: true });
  await store.updateSocio(B.id, { cedula: "9130002", es_socio_olimpia: true });
  await store.setMembresia(B.id, { tierSlug: "socio", ciclo: "anio", pagoRef: "socio:test" });
  await store.upsertSociosClub([{ cedula: "9130001", grupo: "ESTADIO", nro_socio: "321", socio_desde: "2013-04-05", fecha_calidad: "carga_masiva", fecha_fuente: "ingreso", antig_anios: 13.5, meses_pagados: 12, activo_erp: true, nombre: "", correo: "", telefono: "", nacimiento: null }]);
  const r = await store.completarSociosDesdeClub();
  assert.ok(r.desde_club >= 1 && r.desde_membresia >= 1);
  const a = await store.getSocioById(A.id), b = await store.getSocioById(B.id);
  assert.deepStrictEqual({ d: String(a.socio_desde).slice(0, 10), n: a.nro_socio, g: a.grupo_club }, { d: "2013-04-05", n: "321", g: "ESTADIO" }, "la fecha de un día de carga masiva cuenta");
  assert.strictEqual(String(b.socio_desde).slice(0, 10), hoyPy(), "sin dato de la base: desde que se lo reconoció");
});

test("pantalla: resultados de mora, baja y reintento, aviso permanente y botón 'Ya pagué'", () => {
  const s = leer("public", "js", "socio.js");
  assert.match(s, /r\.estado === "mora"/);
  assert.match(s, /body: \{ reintentar: true \}/);
  assert.match(s, /socio-banner-club/);
  assert.match(s, /sv\.club_estado === "mora"/);
  const i = leer("public", "js", "i18n.js");
  for (const k of ["up_mora_h", "up_mora_p", "up_mora_p2", "up_baja_h", "up_baja_p", "up_portal", "up_ya_pague", "up_reintentar_h", "up_reintentar_p", "up_sigue_mora", "mo_banner", "ba_banner"]) assert.ok(i.split(" " + k + ":").length - 1 >= 2, k);
});
