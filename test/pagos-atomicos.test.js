"use strict";
// Cobro y entrega atómicos: webhook de Pagopar, reintentos, reversión y conciliación.
// Pagopar se simula con un servidor local (el cliente acepta PAGOPAR_API_URL).
const PUERTO_FAKE = 29871;   // fuera del rango de puertos efímeros (32768+)
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";
process.env.PAGOPAR_PUBLIC_TOKEN = "publico-de-prueba";
process.env.PAGOPAR_PRIVATE_TOKEN = "privado-de-prueba";
process.env.PAGOPAR_API_URL = `http://127.0.0.1:${PUERTO_FAKE}/api`;

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const http = require("http");

const app = require("../server");
const { getStore } = require("../data/store");
const mailer = require("../lib/email");
const store = getStore();

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const tokenDe = (hash) => sha1("privado-de-prueba" + hash);

let srv, url, fake;
const pagadosEnPagopar = new Set(); // hashes que el Pagopar falso da por pagados
let consultas = 0;

before(async () => {
  fake = await new Promise((res) => {
    const s = http.createServer((req, rsp) => {
      let cuerpo = "";
      req.on("data", (c) => (cuerpo += c));
      req.on("end", () => {
        consultas++;
        const { hash_pedido } = JSON.parse(cuerpo || "{}");
        rsp.setHeader("Content-Type", "application/json");
        rsp.end(JSON.stringify({ respuesta: true, resultado: [{ hash_pedido, pagado: pagadosEnPagopar.has(hash_pedido), cancelado: false }] }));
      });
    }).listen(PUERTO_FAKE, () => res(s));
  });
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv && srv.close(); fake && fake.close(); });

// Espías: cuántas veces se activa una membresía y se manda el mail de bienvenida.
let activaciones, bienvenidas, fallarProximaActivacion;
const origSetMembresia = store.setMembresia.bind(store);
const origBienvenida = mailer.enviarBienvenidaCompra;
beforeEach(() => {
  activaciones = 0; bienvenidas = 0; fallarProximaActivacion = false; consultas = 0;
  store.setMembresia = async (...a) => {
    if (fallarProximaActivacion) { fallarProximaActivacion = false; throw new Error("la base no respondió"); }
    activaciones++;
    return origSetMembresia(...a);
  };
  mailer.enviarBienvenidaCompra = async () => { bienvenidas++; return { ok: true }; };
});
after(() => { store.setMembresia = origSetMembresia; mailer.enviarBienvenidaCompra = origBienvenida; });

let n = 0;
async function pedidoNuevo(extra = {}) {
  n++;
  const socio = await store.createSocio({ email: `pago${n}-${Date.now()}@ejemplo.com`, passwordHash: "x", nombre: "Pagador" });
  const hash = "hash-" + crypto.randomBytes(6).toString("hex");
  const pedido = await store.createPedidoPago({ socioId: socio.id, concepto: "Membresía Plus", monto: 180000, moneda: "PYG", tierSlug: "premium", ciclo: "anio", refExterna: hash, ...extra });
  return { socio, hash, pedido };
}
const webhook = (hash, pagado = true, token = tokenDe(hash)) =>
  fetch(url + "/api/pagos/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resultado: [{ hash_pedido: hash, token, pagado }] }) });
const conciliar = () => fetch(url + "/api/cron/conciliar-pagos", { method: "POST", headers: { "x-cron-token": "secreto-de-cron-de-prueba" } });
const hace = (min) => new Date(Date.now() - min * 60000).toISOString();

test("webhook válido: marca pagado, entrega la membresía y registra que se cumplió", async () => {
  const { socio, hash, pedido } = await pedidoNuevo();
  const r = await webhook(hash);
  assert.strictEqual(r.status, 200);
  const p = await store.getPedidoPago(pedido.id);
  assert.strictEqual(p.estado, "pagado");
  assert.ok(p.cumplido_en, "queda marcado como entregado");
  assert.strictEqual((await store.getMembresia(socio.id)).tier_slug, "premium");
  assert.strictEqual(activaciones, 1);
});

test("webhook con token inválido: 401 y no cambia nada", async () => {
  const { socio, hash, pedido } = await pedidoNuevo();
  const r = await webhook(hash, true, "token-falso");
  assert.strictEqual(r.status, 401);
  assert.strictEqual((await store.getPedidoPago(pedido.id)).estado, "pendiente");
  assert.notStrictEqual(((await store.getMembresia(socio.id)) || {}).tier_slug, "premium");
});

test("5 webhooks simultáneos del mismo pago: se entrega UNA sola vez", async () => {
  const { hash, pedido } = await pedidoNuevo();
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => webhook(hash)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.strictEqual(activaciones, 1, "una sola activación");
  await new Promise((x) => setTimeout(x, 50));
  assert.strictEqual(bienvenidas, 1, "un solo mail de bienvenida");
  assert.ok((await store.getPedidoPago(pedido.id)).cumplido_en);
});

test("el reintento de Pagopar después de entregado no vuelve a entregar", async () => {
  const { hash } = await pedidoNuevo();
  await webhook(hash);
  await webhook(hash);
  await webhook(hash);
  assert.strictEqual(activaciones, 1);
});

test("si la entrega falla: 500 (Pagopar reintenta), el pedido queda pagado SIN cumplir, y el reintento sí entrega", async () => {
  const { socio, hash, pedido } = await pedidoNuevo();
  fallarProximaActivacion = true;
  const r1 = await webhook(hash);
  assert.ok(r1.status >= 500, "responde error para que Pagopar reintente (fue " + r1.status + ")");
  const a = await store.getPedidoPago(pedido.id);
  assert.strictEqual(a.estado, "pagado");
  assert.ok(!a.cumplido_en, "no se marcó como entregado");
  assert.notStrictEqual(((await store.getMembresia(socio.id)) || {}).tier_slug, "premium");

  const r2 = await webhook(hash); // el reintento de Pagopar
  assert.strictEqual(r2.status, 200);
  assert.ok((await store.getPedidoPago(pedido.id)).cumplido_en, "ahora sí quedó entregado");
  assert.strictEqual((await store.getMembresia(socio.id)).tier_slug, "premium");
  assert.strictEqual(activaciones, 1);
});

test("reversión: pasa a reversado una sola vez y deja UN aviso para revisión manual", async () => {
  const { hash, pedido, socio } = await pedidoNuevo();
  await webhook(hash);
  let avisos = 0;
  const orig = store.crearActualizacion;
  store.crearActualizacion = async (d) => { if (d.tipo === "pago_reversado") avisos++; return orig ? orig.call(store, d) : null; };
  try {
    await Promise.all([webhook(hash, false), webhook(hash, false), webhook(hash, false)]);
  } finally { store.crearActualizacion = orig; }
  assert.strictEqual((await store.getPedidoPago(pedido.id)).estado, "reversado");
  assert.strictEqual(avisos, 1, "un solo aviso aunque lleguen tres webhooks");
  assert.ok(socio.id);
});

test("conciliación: un pago que el webhook nunca avisó se detecta preguntando a Pagopar", async () => {
  const { socio, hash, pedido } = await pedidoNuevo();
  const { hash: hashSinPagar, pedido: pedidoSinPagar } = await pedidoNuevo();
  await store.updatePedidoPago(pedido.id, { creado: hace(30) });
  await store.updatePedidoPago(pedidoSinPagar.id, { creado: hace(30) });
  pagadosEnPagopar.add(hash);
  const r = await conciliar();
  assert.strictEqual(r.status, 200);
  const out = await r.json();
  assert.strictEqual(out.acreditados, 1);
  assert.strictEqual((await store.getPedidoPago(pedido.id)).estado, "pagado");
  assert.strictEqual((await store.getMembresia(socio.id)).tier_slug, "premium");
  assert.strictEqual((await store.getPedidoPago(pedidoSinPagar.id)).estado, "pendiente", "el que Pagopar no marca pagado no se toca");
  assert.ok(hashSinPagar);
});

test("conciliación: no consulta pedidos recién creados (el cliente todavía está pagando)", async () => {
  const { pedido, hash } = await pedidoNuevo();
  pagadosEnPagopar.add(hash);
  const out = await (await conciliar()).json();
  assert.strictEqual(out.acreditados, 0);
  assert.strictEqual((await store.getPedidoPago(pedido.id)).estado, "pendiente");
});

test("conciliación: completa la entrega de un pedido pagado que quedó a medias", async () => {
  const { socio, pedido } = await pedidoNuevo();
  await store.updatePedidoPago(pedido.id, { estado: "pagado", pagado_en: hace(20), creado: hace(21) }); // pagado, sin cumplido_en
  const out = await (await conciliar()).json();
  assert.strictEqual(out.reintentados, 1);
  assert.ok((await store.getPedidoPago(pedido.id)).cumplido_en);
  assert.strictEqual((await store.getMembresia(socio.id)).tier_slug, "premium");
});

test("conciliación y cron: solo con CRON_SECRET", async () => {
  const r = await fetch(url + "/api/cron/conciliar-pagos", { method: "POST", headers: { "x-cron-token": "otro" } });
  assert.strictEqual(r.status, 401);
  const r2 = await fetch(url + "/api/cron/conciliar-pagos", { method: "POST" });
  assert.strictEqual(r2.status, 401);
});

test("admin 'activar' usa la misma puerta: entrega lotes de subasta y no duplica si el webhook ya lo hizo", async () => {
  const futuro = new Date(Date.now() + 3600000).toISOString();
  const sub = await store.crearSubasta({ titulo: "Lote de prueba", estado: "cerrada", termina: futuro, precio_inicial: 500000 });
  const socio = await store.createSocio({ email: `ganador-${Date.now()}@ejemplo.com`, passwordHash: "x", nombre: "Ganador" });
  await store.updateSubasta(sub.id, { ganador_id: socio.id });
  const pedido = await store.createPedidoPago({ socioId: socio.id, concepto: "Subasta: Lote", monto: 500000, moneda: "PYG", subastaId: sub.id });
  const activar = () => fetch(url + `/api/admin/pedidos/${pedido.id}/activar`, { method: "POST", headers: { "x-admin-key": "clave-admin-de-prueba" } });

  const r1 = await activar();
  assert.strictEqual(r1.status, 200, await r1.clone().text());
  assert.strictEqual((await store.getSubasta(sub.id)).pago_estado, "pagado", "antes el admin no marcaba el lote como pagado");
  const r2 = await (await activar()).json();
  assert.strictEqual(r2.ya_procesado, true, "la segunda vez no entrega de nuevo");
});
