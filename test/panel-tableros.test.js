"use strict";
// Panel por rol: "Para hacer ahora" (colas de pendientes), Gerencia (período contra período) y Red de comercios (ranking, dormidos, ofertas por vencer).
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const adminAuth = require("../lib/admin-auth");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const OWNER = { "x-admin-key": "clave-admin-de-prueba" };
const tokens = {};
async function como(rol) {
  if (!tokens[rol]) { await adminAuth.crearAdminUsuario({ usuario: `t-${rol}`, nombre: rol, password: "clave-de-prueba-1", rol }); tokens[rol] = (await adminAuth.loginAdmin({ usuario: `t-${rol}`, password: "clave-de-prueba-1" })).token; }
  return { "x-admin-token": tokens[rol] };
}
let n = 0;
async function socio() {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `pt${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Persona" + n } });
  return (await r.json()).socio;
}
const cola = (d, clave) => (d.colas.find((c) => c.clave === clave) || { n: 0, envejecidos: 0 });

test("Para hacer ahora: cuenta lo que espera al equipo, con antigüedad, y no trae nombres ni datos personales", async () => {
  const s = await socio();
  const ped = await store.createPedidoPago({ socioId: s.id, concepto: "Membresía Plus", monto: 180000, moneda: "PYG", tierSlug: "premium", ciclo: "anio" });
  await store.updatePedidoPago(ped.id, { creado: new Date(Date.now() - 72 * 3600000).toISOString() }).catch(() => {});
  const co = await store.crearComercio({ nombre: "Comercio Pendiente " + n, ciudad: "Asunción", contacto: "c@ejemplo.com" });
  await store.crearBeneficioComercio({ comercioId: co.id, titulo: "Oferta en borrador " + n, valor: "10%", pct: 10, niveles: "todos" });   // como la carga un comercio: queda en borrador
  await api("/penas/solicitud", { metodo: "POST", cuerpo: { nombre: "Peña Pendiente " + n, ciudad: "Asunción", pais_iso: "PY", presidente: "Presi Dente", contacto: `pp${n}-${Date.now()}@ejemplo.com` } });
  const d = await (await api("/admin/pendientes", { h: OWNER })).json();
  assert.ok(cola(d, "pagos").n >= 1 && cola(d, "ofertas").n >= 1 && cola(d, "penas").n >= 1, JSON.stringify(d.colas.map((c) => [c.clave, c.n])));
  for (const c of d.colas) for (const k of ["clave", "titulo", "seccion", "area", "n", "envejecidos", "mas_viejo", "nota"]) assert.ok(k in c, c.clave + "." + k);
  assert.strictEqual(d.total, d.colas.reduce((a, c) => a + c.n, 0));
  const txt = JSON.stringify(d);
  assert.ok(!/ejemplo\.com|Persona\d|Presi Dente|Peña Pendiente|Oferta en borrador/.test(txt), "solo números y antigüedad: nunca nombres, correos ni títulos");
  assert.ok(cola(d, "pagos").mas_viejo, "cada cola dice desde cuándo espera");
});

test("Para hacer ahora: cada rol ve solo las colas de sus secciones", async () => {
  const cd = await (await api("/admin/pendientes", { h: await como("cd") })).json();
  const claves = cd.colas.map((c) => c.clave);
  for (const ok of ["ofertas", "penas", "subastas", "canjes_pena", "canjes_puntos"]) assert.ok(claves.includes(ok), "la CD ve " + ok);
  for (const no of ["pagos", "atencion", "validaciones"]) assert.ok(!claves.includes(no), "la CD no ve " + no);
  const com = (await (await api("/admin/pendientes", { h: await como("comercial") })).json()).colas.map((c) => c.clave);
  assert.ok(com.includes("ofertas") && !com.includes("pagos") && !com.includes("atencion"));
  const fin = (await (await api("/admin/pendientes", { h: await como("finanzas") })).json()).colas.map((c) => c.clave);
  assert.ok(fin.includes("pagos") && !fin.includes("atencion") && !fin.includes("validaciones"), "finanzas ve pagos y no atención ni validaciones");
  assert.strictEqual((await api("/admin/pendientes")).status >= 400, true, "sin credenciales no");
});

test("Gerencia: ingresos, altas, canjes y ahorro del período contra el anterior, el nivel Socio y las peñas", async () => {
  const s = await socio();
  const ped = await store.createPedidoPago({ socioId: s.id, concepto: "Membresía Plus", monto: 180000, moneda: "PYG", tierSlug: "premium", ciclo: "anio" });
  await store.updatePedidoPago(ped.id, { estado: "pagado", pagado_en: new Date().toISOString() });
  const d = await (await api("/admin/gerencia", { h: OWNER })).json();
  for (const k of ["ingresos", "altas", "canjes", "club", "penas"]) assert.ok(k in d, k);
  assert.ok(d.ingresos.d30.actual >= 180000 && d.ingresos.d7.actual >= 180000);
  assert.ok(d.altas.d30.actual >= 1);
  for (const p of [d.ingresos.d30, d.altas.d30, d.canjes.d30]) assert.ok("actual" in p && "previo" in p && "delta_pct" in p);
  assert.strictEqual(d.ingresos.d30.previo === 0 ? d.ingresos.d30.delta_pct : null, d.ingresos.d30.previo === 0 ? null : null, "sin período previo no se inventa un porcentaje");
  for (const k of ["socios_activos", "pausados_mora", "pausados_baja", "deuda_en_mora"]) assert.ok(k in d.club, k);
  for (const k of ["verificadas", "activas_60", "dormidas_60"]) assert.ok(k in d.penas, k);
  assert.ok(!/@/.test(JSON.stringify(d)), "agregado: sin correos");
  assert.strictEqual((await api("/admin/gerencia", { h: await como("cd") })).status, 200, "la CD lo ve");
});

test("Red de comercios: ranking por canjes, comercios dormidos y ofertas que vencen en 14 días", async () => {
  const s = await socio();
  const activo = await store.crearComercio({ nombre: "Activo " + n, ciudad: "Asunción", contacto: "a@ejemplo.com" });
  const dormido = await store.crearComercio({ nombre: "Dormido " + n, ciudad: "Luque", contacto: "d@ejemplo.com" });
  const b1 = await store.crearBeneficio({ comercio_id: activo.id, titulo: "Activa " + n, valor: "10%", pct: 10, niveles: "todos", estado: "aprobado", activo: true });
  await store.crearBeneficio({ comercio_id: dormido.id, titulo: "Sin uso " + n, valor: "10%", pct: 10, niveles: "todos", estado: "aprobado", activo: true, vigencia_hasta: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) });
  await store.canjearBeneficio({ beneficioId: b1.id, socioId: s.id, comercioId: activo.id, validadoPor: "t", monto: 100000, ahorro: 10000, tierSlug: "olimpista" });
  const d = await (await api("/admin/comercial", { h: OWNER })).json();
  assert.ok(d.ranking.some((c) => c.nombre === "Activo " + n && c.canjes_30 === 1 && c.ahorro_30 === 10000), "el que canjeó está en el ranking");
  assert.ok(d.dormidos.some((c) => c.nombre === "Dormido " + n), "el que tiene ofertas y ningún canje está dormido");
  assert.ok(!d.dormidos.some((c) => c.nombre === "Activo " + n));
  assert.ok(d.por_vencer.some((b) => b.titulo === "Sin uso " + n), "la oferta que vence en 5 días aparece");
  for (const k of ["comercios", "activos", "con_ofertas", "dormidos", "canjes_30", "canjes_prev", "ahorro_30"]) assert.ok(k in d.red, k);
  assert.ok(!/@|Persona/.test(JSON.stringify(d)), "sin datos de hinchas ni correos");
  assert.strictEqual((await api("/admin/comercial", { h: await como("comercial") })).status, 200);
  assert.strictEqual((await api("/admin/comercial", { h: await como("soporte") })).status, 403, "soporte no tiene la sección de comercios");
});

test("el Dashboard abre con 'Para hacer ahora' y suma Gerencia y Red de comercios", () => {
  const a = leer("public", "admin.html");
  assert.ok(/id="paraHacer"/.test(a) && /id="gerenciaBox"/.test(a) && /id="comercialBox"/.test(a));
  assert.ok(/dashboard: \[cargarPendientes, cargarTablero, cargarGerencia, cargarComercial/.test(a));
  for (const f of ["cargarPendientes", "cargarGerencia", "cargarComercial"]) assert.ok(new RegExp("async function " + f + "\\(\\)").test(a), f);
  assert.ok(/href="#\/' \+ esc\(c\.area\)/.test(a), "cada fila lleva al área donde se resuelve");
});
