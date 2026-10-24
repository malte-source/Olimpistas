"use strict";
// Validación de socio con la base del club: usa el estado guardado si es reciente, guarda lo que consulta, enriquece con la antigüedad
// creíble, y la inscripción con cédula consulta el club y activa el nivel al confirmar el correo.
const PUERTO_TUTI = 29882;   // fuera del rango de puertos efímeros (32768+): en CI los servidores de prueba toman puertos de ahí y chocaban con este
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";
process.env.TUTI_API_HOST = `http://127.0.0.1:${PUERTO_TUTI}`;
process.env.TUTI_API_KEY = "falso";
process.env.TUTI_MERCHANT_KEY = "falso";
process.env.TUTI_PAUSA_MS = "0";
process.env.TUTI_LOTE = "3";

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

let srv, url, club, consultas = [];
before(async () => {
  club = await new Promise((res) => { const s = http.createServer((req, rs) => {
    const doc = new URL(req.url, "http://x").searchParams.get("documentNumber") || ""; consultas.push(doc);
    const base = { documentNumber: doc, documentType: "CI", firstName: "X", lastName: "Y", subscriptionNumber: 9001, plan: "Socio Pleno", autoDebitEnabled: false, debtor: false, totalDebt: 0 };
    rs.setHeader("Content-Type", "application/json");
    if (doc.endsWith("1")) return rs.end(JSON.stringify({ ...base, status: "ACTIVE" }));
    if (doc.endsWith("4")) return rs.end(JSON.stringify({ ...base, status: "UNSUBSCRIBED" }));
    rs.statusCode = 404; rs.end(JSON.stringify({ errors: [{ code: "SUB-027" }] }));
  }).listen(PUERTO_TUTI, () => res(s)); });
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv && srv.close(); club && club.close(); });
beforeEach(() => { tuti.__resetBloqueo(); consultas = []; });

const api = (ruta, { metodo = "GET", cuerpo, h = {}, redirect } = {}) => fetch(url + "/api" + ruta, { method: metodo, redirect, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function cuenta(extra = {}) {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `cv${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Prueba", ...extra } });
  const { token, socio } = await r.json();
  return { id: socio.id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}
const reg = (cedula, extra = {}) => ({ cedula, grupo: "ESTADIO", nro_socio: "555", socio_desde: "2012-06-01", fecha_calidad: "creible", antig_anios: 14, meses_pagados: 30, activo_erp: true, nombre: "Ana Gomez", correo: "", telefono: "", nacimiento: null, ...extra });

test("validar: si el estado guardado es reciente no vuelve a llamar a la API, y la ficha se completa con la antigüedad creíble, el número y el grupo", async () => {
  await store.upsertSociosClub([reg("8100001")]);
  await store.guardarEstadoTuti("8100001", { estado: "ACTIVE", plan: "Socio Pleno", numero: "9001", alDia: true, deuda: 0 });
  const A = await cuenta();
  const r = await (await api("/perfil/validar-socio", { metodo: "POST", h: A.h, cuerpo: { cedula: "8100001" } })).json();
  assert.strictEqual(r.validado, true);
  assert.deepStrictEqual(consultas, [], "usó lo guardado");
  const s = await store.getSocioById(A.id);
  assert.deepStrictEqual({ desde: String(s.socio_desde).slice(0, 10), nro: s.nro_socio, grupo: s.grupo_club, socio: s.es_socio_olimpia, plan: s.plan_club }, { desde: "2012-06-01", nro: "555", grupo: "ESTADIO", socio: true, plan: "Socio Pleno" });
  const c = (await (await api("/carnet", { h: A.h })).json()).carnet;
  assert.deepStrictEqual({ esSocio: c.esSocio, socioDesde: c.socioDesde, nroSocio: c.nroSocio }, { esSocio: true, socioDesde: "2012-06-01", nroSocio: "555" });
});

test("validar: una cédula sin estado guardado se consulta en vivo UNA vez y queda guardada para la próxima", async () => {
  const A = await cuenta(), B = await cuenta();
  const r1 = await (await api("/perfil/validar-socio", { metodo: "POST", h: A.h, cuerpo: { cedula: "8200001" } })).json();
  assert.strictEqual(r1.validado, true);
  assert.deepStrictEqual(consultas, ["8200001"]);
  assert.strictEqual((await store.getSocioClub("8200001")).tuti_estado, "ACTIVE");
  // otra persona que prueba una cédula dada de baja: se consulta, se guarda y se le dice lo mismo que a quien no figura
  const r2 = await (await api("/perfil/validar-socio", { metodo: "POST", h: B.h, cuerpo: { cedula: "8200004" } })).json();
  assert.deepStrictEqual({ validado: r2.validado, estado: r2.estado }, { validado: false, estado: "a_revisar" });
  assert.strictEqual((await store.getSocioClub("8200004")).tuti_estado, "UNSUBSCRIBED");
  consultas.length = 0;
  const C = await cuenta();
  await api("/perfil/validar-socio", { metodo: "POST", h: C.h, cuerpo: { cedula: "8200004" } });
  assert.deepStrictEqual(consultas, [], "el estado de baja guardado hace menos de una hora no se vuelve a consultar");
});

test("inscripción con cédula: se guarda, se consulta y queda guardado el estado; el nivel Socio se activa al confirmar el correo", async () => {
  const A = await cuenta({ cedula: "8300001" });
  await new Promise((x) => setTimeout(x, 150));
  let s = await store.getSocioById(A.id);
  assert.strictEqual(s.cedula, "8300001");
  assert.strictEqual(s.es_socio_olimpia, false, "todavía no: falta confirmar el correo");
  assert.deepStrictEqual(consultas, ["8300001"], "se consultó el estado al inscribirse");
  assert.strictEqual((await store.getSocioClub("8300001")).tuti_estado, "ACTIVE");
  const r = await api("/auth/verificar?token=" + s.verif_token, { redirect: "manual" });
  assert.match(r.headers.get("location"), /verificado=1$/);
  await new Promise((x) => setTimeout(x, 200));
  s = await store.getSocioById(A.id);
  assert.strictEqual(s.es_socio_olimpia, true, "al confirmar el correo se activa solo");
  assert.strictEqual(consultas.length, 1, "sin consultar de nuevo: usó el estado guardado");
});

test("inscripción: una cédula que ya tiene otra cuenta no se guarda ni da error, y sin cédula todo sigue igual", async () => {
  await cuenta({ cedula: "8400001" });
  const B = await cuenta({ cedula: "8400001" });
  assert.ok(B.id);
  assert.ok(!(await store.getSocioById(B.id)).cedula, "no se le asigna la cédula de otra persona");
  const C = await cuenta();
  assert.ok(!(await store.getSocioById(C.id)).cedula);
  const D = await cuenta({ cedula: "12" });
  assert.ok(!(await store.getSocioById(D.id)).cedula, "una cédula inválida se ignora");
});

test("el cron horario consulta un lote chico de la base (TUTI_LOTE) y el panel muestra el avance sin datos personales", async () => {
  await store.upsertSociosClub(["8500001", "8500002", "8500003", "8500005", "8500006"].map((c) => reg(c)));
  const r = await (await api("/cron/horario", { metodo: "POST", h: { "x-cron-token": "secreto-de-cron-de-prueba" }, cuerpo: {} })).json();
  assert.strictEqual(r.clubSync.consultadas, 3, "el lote respeta TUTI_LOTE");
  assert.ok(r.clubSync.pedidas <= 3);
  const res = await (await api("/admin/club/resumen", { h: { "x-admin-key": "clave-admin-de-prueba" } })).json();
  assert.ok(res.consultados >= 3 && res.pendientes >= 2);
  assert.strictEqual(res.api_habilitada, true);
  assert.strictEqual(res.lote, 3);
  assert.ok(!/ana gomez|8500001/i.test(JSON.stringify(res)), "sin datos personales");
  assert.ok([401, 403].includes((await api("/admin/club/resumen")).status));
});

test("pantalla: cédula opcional plegada en la inscripción y la base del club en el panel", () => {
  const o = leer("public", "js", "onboarding.js");
  assert.match(o, /<details class="ob-socio"><summary>\$\{T\("ob_socio_q"\)\}<\/summary>/);
  assert.match(o, /\.\.\.\(cedula\.length >= 5 \? \{ cedula \} : \{\}\)/);
  assert.match(leer("public", "admin.html"), /api\("\/admin\/club\/resumen"\)/);
  const i = leer("public", "js", "i18n.js");
  for (const k of ["ob_socio_q", "ob_socio_p"]) assert.ok(i.split(" " + k + ":").length - 1 >= 2, k);
});
