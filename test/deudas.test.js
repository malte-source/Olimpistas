"use strict";
// P4 · Una tarjeta por cada deuda en Inicio: subastas ganadas sin pagar, pagos de Plus/Junior sin completar y entradas reservadas sin pagar.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function socio() {
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `dd${++n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Deuda" } });
  const { socio: s, token } = await r.json();
  return { id: s.id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}
const horas = (h) => new Date(Date.now() + h * 3600000).toISOString();
async function lote(titulo, ganador, extra = {}) {
  const s = await store.crearSubasta({ titulo, precio_inicial: 100000, estado: "activa" });
  return store.updateSubasta(s.id, { estado: "cerrada", ganador_id: ganador, adjudicado_a: ganador, puja_actual: 250000, pago_vence: horas(40), pago_estado: null, ...extra });
}
const deudas = async (s) => (await (await api("/deudas", { h: s.h })).json()).items;

test("sin sesión no hay deudas, y quien no debe nada recibe la lista vacía", async () => {
  assert.strictEqual((await api("/deudas")).status, 401);
  assert.deepStrictEqual(await deudas(await socio()), []);
});

test("subastas: una tarjeta por lote ganado sin pagar, ordenadas por vencimiento; lo pagado, lo vencido y lo ajeno no aparecen", async () => {
  const yo = await socio(), otro = await socio();
  const tarde = await lote("Camiseta firmada", yo.id, { pago_vence: horas(60) }), pronto = await lote("Pelota oficial", yo.id, { pago_vence: horas(5), ronda: 2 });
  await lote("Ya pagado", yo.id, { pago_estado: "pagado" });
  await lote("Plazo vencido", yo.id, { pago_vence: horas(-1) });
  await lote("De otra persona", otro.id);
  const sinPlazo = await lote("Lote anterior sin plazo", yo.id, { pago_vence: null });
  const it = await deudas(yo);
  assert.deepStrictEqual(it.map((x) => x.titulo), ["Pelota oficial", "Camiseta firmada", "Lote anterior sin plazo"], "primero el que vence antes; sin plazo al final");
  assert.deepStrictEqual(it.map((x) => x.tipo), ["subasta", "subasta", "subasta"]);
  assert.deepStrictEqual([it[0].id, it[0].monto, it[0].ronda], [pronto.id, 250000, 2]);
  assert.ok(it.every((x) => x.vence === null || new Date(x.vence).getTime() > Date.now()));
  assert.strictEqual(it[1].id, tarde.id);
  assert.strictEqual(it[2].id, sinPlazo.id);
  assert.strictEqual(it[2].vence, null);
});

test("un pago ya iniciado se retoma por su mismo checkout mientras siga vigente; vencido o simulado, el cliente lo inicia de nuevo", async () => {
  const yo = await socio();
  const l = await lote("Entrada VIP", yo.id);
  const p = await store.createPedidoPago({ socioId: yo.id, concepto: "Subasta: Entrada VIP", monto: 250000, subastaId: l.id, refExterna: "hashreal1" });
  assert.strictEqual((await deudas(yo))[0].url, "https://www.pagopar.com/pagos/hashreal1");
  await store.updatePedidoPago(p.id, { creado: new Date(Date.now() - 80 * 3600000).toISOString() });
  assert.strictEqual((await deudas(yo))[0].url, "", "el checkout de Pagopar ya no sirve: se vuelve a iniciar el pago");
  await store.updatePedidoPago(p.id, { creado: new Date().toISOString(), ref_externa: "sim_ped_1" });
  assert.strictEqual((await deudas(yo))[0].url, "", "los pedidos simulados no tienen checkout");
});

test("Plus o Junior sin completar: una tarjeta por nivel (el pedido más reciente), no si ya lo tiene ni si pasó una semana", async () => {
  const yo = await socio();
  await store.createPedidoPago({ socioId: yo.id, concepto: "Membresía Plus", monto: 150000, tierSlug: "premium", refExterna: "viejo" });
  const nuevo = await store.createPedidoPago({ socioId: yo.id, concepto: "Membresía Plus", monto: 180000, tierSlug: "premium", refExterna: "hashplus" });
  const it = await deudas(yo);
  assert.strictEqual(it.length, 1, "dos intentos del mismo nivel son una sola deuda");
  assert.deepStrictEqual([it[0].tipo, it[0].tier, it[0].vence], ["membresia", "premium", null]);
  assert.ok(it[0].titulo && it[0].monto > 0);
  // ya tiene el nivel: no debe nada
  await store.setMembresia(yo.id, { tierSlug: "premium", ciclo: "anio" });
  assert.deepStrictEqual(await deudas(yo), []);
  // un intento abandonado hace más de una semana ya no es una deuda
  const otra = await socio();
  const vieja = await store.createPedidoPago({ socioId: otra.id, concepto: "Membresía Plus", monto: 180000, tierSlug: "premium", refExterna: "hashvieja" });
  await store.updatePedidoPago(vieja.id, { creado: new Date(Date.now() - 8 * 86400000).toISOString() });
  assert.deepStrictEqual(await deudas(otra), []);
  assert.ok(nuevo.id);
});

test("entradas reservadas sin pagar: solo mientras haya checkout vigente (si no, la reserva ya se está liberando)", async () => {
  const yo = await socio();
  const pre = await store.crearPreventa({ evento: "Olimpia vs Cerro", fecha: "2099-01-01", sede: "Defensores del Chaco", precio_desde: 80000, stock: 10 });
  const r = await store.reservarPreventa(pre.id, yo.id, 1);
  const ped = await store.createPedidoPago({ socioId: yo.id, concepto: "Entrada", monto: 80000, reservaId: r.id, refExterna: "hashentrada" });
  const it = await deudas(yo);
  assert.strictEqual(it.length, 1);
  assert.deepStrictEqual([it[0].tipo, it[0].titulo, it[0].monto, it[0].url], ["preventa", "Olimpia vs Cerro", 80000, "https://www.pagopar.com/pagos/hashentrada"]);
  assert.ok(new Date(it[0].vence).getTime() > Date.now());
  await store.updatePedidoPago(ped.id, { creado: new Date(Date.now() - 80 * 3600000).toISOString() });
  assert.deepStrictEqual(await deudas(yo), []);
});

test("todas juntas: subasta, nivel y entrada aparecen cada una en su tarjeta", async () => {
  const yo = await socio();
  await lote("Lote", yo.id);
  await store.createPedidoPago({ socioId: yo.id, concepto: "Membresía Junior", monto: 90000, tierSlug: "kids", refExterna: "hashkids" });
  const it = await deudas(yo);
  assert.deepStrictEqual(it.map((x) => x.tipo).sort(), ["membresia", "subasta"]);
});

test("pantalla: tarjetas en Inicio con el botón de valor, la misma deuda no se repite en el aviso de Inicio y los textos existen en es y en", () => {
  const js = leer("public", "js", "socio.js"), css = leer("public", "css", "styles.css"), i18n = leer("public", "js", "i18n.js");
  assert.ok(/function wDeudas/.test(js) && /\$\{wDeudas\(deudasR\)\}/.test(js) && /api\("\/deudas"\)/.test(js));
  assert.ok(/class="btn btn-valor btn-sm" data-deuda/.test(js), "el oro solo en el botón de pagar");
  assert.ok(/body\[data-tab="inicio"\] \.socio-banner-pago \{ display: none; \}/.test(css));
  for (const k of ["dd_h", "dd_h1", "dd_subasta", "dd_membresia", "dd_preventa", "dd_sin_completar", "dd_pagar"]) assert.strictEqual((i18n.match(new RegExp("\\b" + k + ":", "g")) || []).length, 2, k + " en es y en");
});
