"use strict";
// El nivel Socio sigue al estado en el club: al día lo mantiene; mora o baja lo pausan (con un aviso, una sola vez) y vuelve solo al regularizar.
const PUERTO_TUTI = 29892;   // fuera del rango de puertos efímeros (32768+) y distinto de los demás tests: en CI corren en paralelo
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
process.env.TUTI_BARRIDO = "off";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const app = require("../server");
const { getStore } = require("../data/store");
const tuti = require("../lib/tuti");
const mailer = require("../lib/email");
const store = getStore();

let srv, url, club, avisos = [];
before(async () => {
  club = await new Promise((res) => { const s = http.createServer((req, rs) => {
    const doc = new URL(req.url, "http://x").searchParams.get("documentNumber") || "";
    const base = { documentNumber: doc, documentType: "CI", firstName: "X", lastName: "Y", subscriptionNumber: 9001, plan: "Socio Pleno", autoDebitEnabled: false, debtor: false, totalDebt: 0 };
    rs.setHeader("Content-Type", "application/json");
    if (doc.endsWith("1")) return rs.end(JSON.stringify({ ...base, status: "ACTIVE" }));
    rs.statusCode = 404; rs.end(JSON.stringify({ errors: [{ code: "SUB-027" }] }));
  }).listen(PUERTO_TUTI, () => res(s)); });
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`;
  mailer.enviarCuotaPendiente = async (s, o) => { avisos.push(["mora", s.id, o.deuda]); };
  mailer.enviarSocioBaja = async (s) => { avisos.push(["baja", s.id]); };
});
after(() => { srv && srv.close(); club && club.close(); delete process.env.SOCIO_SINCRONIZAR; });
beforeEach(() => { tuti.__resetBloqueo(); avisos = []; delete process.env.SOCIO_SINCRONIZAR; delete process.env.SOCIO_SINC_LOTE; });

const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const CRON = { "x-cron-token": "secreto-de-cron-de-prueba" }, ADM = { "x-admin-key": "clave-admin-de-prueba" };
let n = 0;
// Una cuenta con nivel Socio, y lo último que el club dijo de su cédula.
async function socio(cedula, estado, { pagoRef = "socio:padron", deuda = 0 } = {}) {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `sn${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Prueba" } });
  const { socio: s, token } = await r.json();
  await store.updateSocio(s.id, { cedula, es_socio_olimpia: true });
  await store.setMembresia(s.id, { tierSlug: "socio", ciclo: "anio", pagoRef });
  await store.upsertSociosClub([{ cedula, grupo: "ESTADIO", nro_socio: "55", socio_desde: "2012-06-01", fecha_calidad: "creible", fecha_fuente: "ingreso", antig_anios: 14, meses_pagados: 1, activo_erp: true, nombre: "", correo: "", telefono: "", nacimiento: null }]);
  if (estado) await store.guardarEstadoTuti(cedula, { estado, plan: "Socio Pleno", numero: "9001", alDia: estado === "ACTIVE" || estado === "LIFETIME", deuda });
  return { id: s.id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}
const cron = async () => (await (await api("/cron/horario", { metodo: "POST", h: CRON, cuerpo: {} })).json()).sincronizacionSocios;
const nivel = async (id) => ({ tier: (await store.getMembresia(id)).tier_slug, socio: !!(await store.getSocioById(id)).es_socio_olimpia, club: (await store.getSocioById(id)).club_estado });

test("apagada: nadie pierde el nivel, y el panel cuenta a quién se le pausaría", async () => {
  const mora = await socio("8400002", "DEBT", { deuda: 150000 }), baja = await socio("8400003", "UNSUBSCRIBED"), dia = await socio("8400004", "ACTIVE");
  const r = await cron();
  assert.strictEqual(r.pausados_mora + r.pausados_baja, 0);
  assert.deepStrictEqual(avisos, []);
  for (const x of [mora, baja, dia]) assert.strictEqual((await nivel(x.id)).tier, "socio");
  const p = (await (await api("/admin/club/resumen", { h: ADM })).json()).sincronizacion;
  assert.strictEqual(p.activada, false);
  assert.ok(p.por_pausar_mora >= 1 && p.por_pausar_baja >= 1 && p.al_dia >= 1);
});

test("encendida: mora y baja pasan a Olimpista con un aviso cada una; al día, lo dado a mano y lo no concluyente no se tocan", async () => {
  process.env.SOCIO_SINCRONIZAR = "on";
  const mora = await socio("8400012", "DEBT", { deuda: 150000 }), baja = await socio("8400013", "UNSUBSCRIBED"), dia = await socio("8400014", "ACTIVE"), vitalicio = await socio("8400015", "LIFETIME");
  const manual = await socio("8400016", "UNSUBSCRIBED", { pagoRef: "admin-manual" }), sinDato = await socio("8400017", "");
  const r = await cron();
  assert.ok(r.pausados_mora >= 1 && r.pausados_baja >= 1);
  assert.deepStrictEqual(await nivel(mora.id), { tier: "olimpista", socio: false, club: "mora" });
  assert.deepStrictEqual(await nivel(baja.id), { tier: "olimpista", socio: false, club: "baja" });
  assert.strictEqual((await store.getSocioById(mora.id)).club_deuda, 150000);
  assert.deepStrictEqual(await nivel(dia.id), { tier: "socio", socio: true, club: "al_dia" });
  assert.deepStrictEqual(await nivel(vitalicio.id), { tier: "socio", socio: true, club: "al_dia" });
  assert.strictEqual((await nivel(manual.id)).tier, "socio", "lo dado a mano por un admin no se toca");
  assert.strictEqual((await nivel(sinDato.id)).tier, "socio", "sin respuesta concluyente del club, no se baja a nadie");
  assert.deepStrictEqual(avisos.filter((a) => a[1] === mora.id), [["mora", mora.id, 150000]]);
  assert.deepStrictEqual(avisos.filter((a) => a[1] === baja.id), [["baja", baja.id]]);
  assert.strictEqual(avisos.filter((a) => [dia.id, vitalicio.id, manual.id, sinDato.id].includes(a[1])).length, 0);
  // una segunda corrida no vuelve a avisar ni a tocar nada de lo ya pausado
  avisos = []; await cron();
  assert.deepStrictEqual(avisos.filter((a) => [mora.id, baja.id].includes(a[1])), []);
});

test("el socio pausado conserva su historia (número, grupo y 'Socio desde') y deja de figurar como socio en el carnet", async () => {
  process.env.SOCIO_SINCRONIZAR = "on";
  const x = await socio("8400022", "DEBT", { deuda: 90000 });
  await store.updateSocio(x.id, { nro_socio: "55", grupo_club: "ESTADIO", socio_desde: "2012-06-01" });
  await cron();
  const s = await store.getSocioById(x.id);
  assert.deepStrictEqual([s.nro_socio, s.grupo_club, String(s.socio_desde).slice(0, 10), s.es_socio_olimpia], ["55", "ESTADIO", "2012-06-01", false]);
  const c = (await (await api("/carnet", { h: x.h })).json()).carnet;
  assert.deepStrictEqual([c.esSocio, c.tierSlug], [false, "olimpista"]);
});

test("las bajadas y avisos por hora tienen tope (SOCIO_SINC_LOTE) y el resto sigue en la próxima corrida", async () => {
  process.env.SOCIO_SINCRONIZAR = "on"; process.env.SOCIO_SINC_LOTE = "2";
  const ids = []; for (let i = 0; i < 4; i++) ids.push((await socio("85000" + (20 + i) + "2".repeat(0), "DEBT", { deuda: 1000 })).id);
  await cron();
  const pausados = async () => (await Promise.all(ids.map(nivel))).filter((x) => x.tier === "olimpista").length;
  assert.ok((await pausados()) <= 2, "no más que el tope");
  assert.ok(avisos.length <= 2);
});

test("al regularizar, la revisión automática le devuelve el nivel Socio sola", async () => {
  process.env.SOCIO_SINCRONIZAR = "on";
  const x = await socio("8400031", "DEBT", { deuda: 70000 });            // la API en vivo dice ACTIVE para cédulas que terminan en 1
  await cron();
  assert.strictEqual((await nivel(x.id)).tier, "olimpista");
  await api("/cron/horario", { metodo: "POST", h: CRON, cuerpo: {} });
  assert.strictEqual((await nivel(x.id)).tier, "olimpista", "recién pausada: la revisión espera una hora");
  await store.updateSocio(x.id, { club_consulta: new Date(Date.now() - 2 * 3600000).toISOString() });
  delete process.env.TUTI_BARRIDO;
  try { await api("/cron/horario", { metodo: "POST", h: CRON, cuerpo: {} }); } finally { process.env.TUTI_BARRIDO = "off"; }
  assert.deepStrictEqual(await nivel(x.id), { tier: "socio", socio: true, club: "al_dia" });
});

test("los avisos existen en español e inglés y la tarjeta se llama Carnet de Olimpista", () => {
  const fs = require("fs"), path = require("path");
  const e = fs.readFileSync(path.join(__dirname, "..", "lib", "email.js"), "utf8"), i = fs.readFileSync(path.join(__dirname, "..", "public", "js", "i18n.js"), "utf8");
  for (const f of ["enviarCuotaPendiente", "enviarSocioBaja"]) assert.ok(new RegExp("async function " + f).test(e) && e.includes(f + ","), f);
  assert.match(i, /cn_titulo: "Carnet de Olimpista"/);
  assert.match(i, /cn_titulo: "Olimpista card"/);
  assert.ok(!/Carnet de hincha/.test(i));
});
