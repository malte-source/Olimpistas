"use strict";
// Portal de la peña: altas por mes (12 meses) y todas las altas en una planilla, sin datos personales y solo las de la propia peña.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const mailer = require("../lib/email");
const { getStore } = require("../data/store");
const store = getStore();

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
beforeEach(() => { mailer.enviarPenaVerificada = async () => ({ ok: true, modo: "resend" }); mailer.enviarPenaSolicitudRecibida = async () => ({ ok: true }); });
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const ADM = { "x-admin-key": "clave-admin-de-prueba" };
let n = 0;
async function pena() {
  n++;
  const id = (await (await api("/penas/solicitud", { metodo: "POST", cuerpo: { nombre: "Peña Altas " + n, ciudad: "Asunción", pais_iso: "PY", presidente: "Presi Dente", contacto: `pa${n}-${Date.now()}@ejemplo.com` } })).json()).id;
  await api("/admin/penas/" + id + "/verificar", { metodo: "POST", h: ADM });
  const u = await store.getPenaUsuarioDePena(id), p = await store.getPena(id);
  await store.updatePenaUsuario(u.id, { password_hash: await bcrypt.hash("clave-pena-123", 4) });
  const login = await (await api("/pena/login", { metodo: "POST", cuerpo: { usuario: u.usuario, password: "clave-pena-123" } })).json();
  return { id, slug: p.slug, h: { "x-pena-token": login.token } };
}
async function alta(slug, nombre, apellido) {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `al${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre, apellido, pena: slug } });
  const s = (await r.json()).socio;
  const q = await store.solicitudPenaPendiente(s.id);   // la comisión acepta el pedido: recién ahí cuenta como alta de la peña
  if (q) await store.resolverSolicitudPena({ id: q.id, por: "pena", aceptar: true });
  return s;
}

test("el panel trae las altas por mes de los últimos 12 meses, con ceros, y cuenta las del link", async () => {
  const P = await pena();
  await alta(P.slug, "Ana", "Gómez"); await alta(P.slug, "Beto", "Ríos");
  const d = await (await api("/pena/panel", { h: P.h })).json();
  assert.strictEqual(d.altas_por_mes.length, 12);
  assert.ok(d.altas_por_mes.every((m) => /^\d{4}-\d{2}$/.test(m.mes) && Number.isInteger(m.n)));
  assert.strictEqual(d.altas_por_mes[11].n, 2, "las dos de este mes");
  assert.strictEqual(d.altas_por_mes.slice(0, 11).reduce((a, m) => a + m.n, 0), 0);
  assert.strictEqual(d.ultimas_altas.length, 2);
});

test("la planilla trae todas las altas de SU peña: nombre, inicial del apellido, ciudad y nivel; nunca correo, teléfono ni cédula", async () => {
  const P = await pena(), Q = await pena();
  await alta(P.slug, "Carla", "Benítez"); await alta(P.slug, "=cmd|' /C calc'!A0", "Zárate"); await alta(Q.slug, "Otra", "Peña");
  const r = await api("/pena/altas.csv", { h: P.h });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.match(r.headers.get("content-disposition"), /attachment; filename="altas-[a-z0-9-]+\.csv"/);
  const t = await r.text(), lineas = t.replace(/^\ufeff/, "").trim().split("\n");
  assert.strictEqual(lineas[0], "fecha_alta,nombre,inicial_apellido,ciudad,nivel");
  assert.strictEqual(lineas.length, 3, "cabecera + las 2 de P (no la de Q)");
  assert.ok(/"Carla","B"/.test(t), "nombre e inicial");
  assert.ok(!/Benítez|Zárate|@|cédula/i.test(t), "sin apellido completo, correo ni cédula");
  assert.ok(!/(^|,)"?=cmd/.test(t) && /"'=cmd/.test(t), "una celda que empieza con = no se interpreta como fórmula");
  assert.ok(!t.includes("Otra"), "no ve las altas de otra peña");
  assert.strictEqual((await api("/pena/altas.csv")).status, 401, "sin sesión no");
});

test("el portal muestra las altas por mes y descarga la planilla sin diálogos del sistema", () => {
  const h = fs.readFileSync(path.join(__dirname, "..", "public", "pena.html"), "utf8");
  assert.ok(/id="altasMes"/.test(h) && /id="altasCsv"/.test(h) && /\/api\/pena\/altas\.csv/.test(h) && /id="altasCsvErr"/.test(h));
  assert.ok(!/\balert\(|\bconfirm\(|\bprompt\(/.test(h), "sin diálogos del sistema");
});
