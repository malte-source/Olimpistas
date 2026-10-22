"use strict";
// Rutas de preventas: tope de 4 por persona, reserva sin cobro queda confirmada y el cron horario libera lo vencido.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba-largo-123";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function hincha() {
  const j = await (await api("/auth/registro", { metodo: "POST", cuerpo: { email: `pv${++n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Pre", apellido: "Venta" } })).json();
  return { id: j.socio.id, h: { Authorization: "Bearer " + j.token, Cookie: "olimpista_sess=" + j.token } };
}

test("comprar/reservar: 4 entradas por persona; la quinta da 409; sin cobro la reserva queda pagada", async () => {
  const pv = await store.crearPreventa({ evento: "Partido ruta", stock: 20, precio_desde: 0, tier_min: "olimpista" });
  const yo = await hincha();
  for (let i = 0; i < 4; i++) { const r = await api(`/preventas/${pv.id}/comprar`, { metodo: "POST", cuerpo: { cantidad: 1 }, h: yo.h }); assert.strictEqual(r.status, 200); }
  const quinta = await api(`/preventas/${pv.id}/comprar`, { metodo: "POST", cuerpo: { cantidad: 1 }, h: yo.h });
  assert.strictEqual(quinta.status, 409);
  assert.match((await quinta.json()).error, /máximo de 4/);
  const otro = await hincha();
  const r = await (await api(`/preventas/${pv.id}/reservar`, { metodo: "POST", cuerpo: { cantidad: 2 }, h: otro.h })).json();
  assert.strictEqual(r.reserva.estado, "pagada");
  assert.strictEqual((await store.getReserva(r.reserva.id)).estado, "pagada");
  assert.strictEqual(Number((await store.getPreventa(pv.id)).stock), 14);
});

test("cron horario: libera las reservas sin pagar vencidas y repone el stock", async () => {
  const pv = await store.crearPreventa({ evento: "Partido cron", stock: 5, precio_desde: 50000, tier_min: "olimpista" });
  const yo = await hincha();
  const res = await store.reservarPreventa(pv.id, yo.id, 3); // queda pendiente_pago (cobro real todavía no se dispara)
  (await store.getReserva(res.id)).creado = new Date(Date.now() - 100 * 3600000).toISOString();
  assert.strictEqual(Number((await store.getPreventa(pv.id)).stock), 2);
  const sin = await api("/cron/horario", { metodo: "POST" });
  assert.strictEqual(sin.status, 401);
  const ok = await api("/cron/horario", { metodo: "POST", h: { "x-cron-token": process.env.CRON_SECRET } });
  assert.strictEqual(ok.status, 200);
  assert.ok((await ok.json()).reservasLiberadas >= 1);
  assert.strictEqual(Number((await store.getPreventa(pv.id)).stock), 5);
  assert.strictEqual((await store.getReserva(res.id)).estado, "cancelada");
});
