"use strict";
// Cupos de preventas contra Postgres real y contra el store en memoria: nunca se vende más que el stock aunque lleguen
// todos a la vez, una persona no acapara, y el cupo sin pagar vuelve al stock (con el pago tardío resuelto sin overselling).
process.env.DB_SSL = "disable";
process.env.OLIMPISTAS_PERSIST = "0";
const BASE = process.env.TEST_DATABASE_URL;
const opts = { skip: BASE ? false : "sin TEST_DATABASE_URL" };

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

let admin, nombreDb, pg, mem, sqlMig;
const urlDe = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
before(async () => {
  mem = require("../data/memory-store").createMemoryStore({ filePath: null });
  if (!BASE) return;
  const postgres = require("postgres");
  admin = postgres(BASE, { prepare: false, max: 1, onnotice: () => {} });
  nombreDb = "t_cupo_" + crypto.randomBytes(4).toString("hex");
  await admin.unsafe(`CREATE DATABASE ${nombreDb}`);
  sqlMig = postgres(urlDe(nombreDb), { prepare: false, max: 1, onnotice: () => {} });
  await require("../lib/migrar").migrar(sqlMig, { log: {} });
  pg = require("../data/pg-store").createPgStore({ databaseUrl: urlDe(nombreDb) });
});
after(async () => {
  if (!BASE) return;
  try { await pg._sql.end({ timeout: 5 }); } catch (e) {}
  try { await sqlMig.end({ timeout: 5 }); } catch (e) {}
  await admin.unsafe(`DROP DATABASE IF EXISTS ${nombreDb} WITH (FORCE)`).catch(() => {});
  await admin.end({ timeout: 5 });
});

const tag = () => crypto.randomBytes(3).toString("hex");
const socio = async (s) => (await s.createSocio({ email: `c-${tag()}@ejemplo.com`, passwordHash: "x", nombre: "C" })).id;
const preventa = (s, stock) => s.crearPreventa({ evento: "Partido " + tag(), stock, precio_desde: 50000, tier_min: "olimpista" });
const stockDe = async (s, id) => Number((await s.getPreventa(id)).stock);
const envejecer = async (s, esPg, reservaId, horas) => {
  if (esPg) await pg._sql`UPDATE reservas SET creado = now() - make_interval(hours => ${horas}) WHERE id = ${reservaId}`;
  else (await s.getReserva(reservaId)).creado = new Date(Date.now() - horas * 3600000).toISOString();
};

for (const [nombre, get] of [["pg", () => pg], ["memoria", () => mem]]) {
  const esPg = nombre === "pg";

  test(`${nombre}: 30 personas a la vez por 7 entradas → se venden exactamente 7 y el stock queda en 0`, opts, async () => {
    const s = get();
    const pv = await preventa(s, 7);
    const ids = await Promise.all(Array.from({ length: 30 }, () => socio(s)));
    const rs = await Promise.all(ids.map((id) => s.reservarPreventa(pv.id, id, 1)));
    assert.strictEqual(rs.filter((r) => r && !r.error).length, 7);
    assert.strictEqual(rs.filter((r) => r && r.error === "sin_stock").length, 23);
    assert.strictEqual(await stockDe(s, pv.id), 0);
  });

  test(`${nombre}: pedidos de varias entradas a la vez nunca pasan el stock (nada de stock negativo)`, opts, async () => {
    const s = get();
    const pv = await preventa(s, 10);
    const ids = await Promise.all(Array.from({ length: 12 }, () => socio(s)));
    const rs = await Promise.all(ids.map((id) => s.reservarPreventa(pv.id, id, 3)));
    const vendidas = rs.filter((r) => r && !r.error).reduce((a, r) => a + r.cantidad, 0);
    assert.ok(vendidas <= 10, "vendidas " + vendidas);
    assert.strictEqual(await stockDe(s, pv.id), 10 - vendidas);
    assert.ok(await stockDe(s, pv.id) >= 0);
  });

  test(`${nombre}: una persona no acapara — tope de 4 entradas por preventa (cuentan las vivas, no las canceladas)`, opts, async () => {
    const s = get();
    const pv = await preventa(s, 50);
    const yo = await socio(s);
    const a = await s.reservarPreventa(pv.id, yo, 3);
    assert.ok(!a.error);
    assert.strictEqual((await s.reservarPreventa(pv.id, yo, 2)).error, "limite");
    assert.ok(!(await s.reservarPreventa(pv.id, yo, 1)).error, "llega a 4");
    assert.strictEqual((await s.reservarPreventa(pv.id, yo, 1)).error, "limite");
    assert.strictEqual(await stockDe(s, pv.id), 46, "las rechazadas no tocan el stock");
    await s.cancelarReservaYreponer(a.id);
    assert.ok(!(await s.reservarPreventa(pv.id, yo, 3)).error, "al cancelar se libera su tope");
  });

  test(`${nombre}: el cupo sin pagar vuelve al stock pasada la ventana; lo pagado y lo reciente no se toca`, opts, async () => {
    const s = get();
    const pv = await preventa(s, 10);
    const [u1, u2, u3] = [await socio(s), await socio(s), await socio(s)];
    const vieja = await s.reservarPreventa(pv.id, u1, 2);
    const pagada = await s.reservarPreventa(pv.id, u2, 2); await s.confirmarReserva(pagada.id);
    const reciente = await s.reservarPreventa(pv.id, u3, 1);
    await envejecer(s, esPg, vieja.id, 100); await envejecer(s, esPg, pagada.id, 100);
    assert.strictEqual(await stockDe(s, pv.id), 5);
    assert.ok(await s.liberarReservasVencidas({ horas: 75 }) >= 1);
    assert.strictEqual(await stockDe(s, pv.id), 7, "volvieron las 2 de la vieja");
    assert.strictEqual((await s.getReserva(vieja.id)).estado, "cancelada");
    assert.strictEqual((await s.getReserva(pagada.id)).estado, "pagada");
    assert.strictEqual((await s.getReserva(reciente.id)).estado, "pendiente_pago");
    assert.strictEqual(await s.liberarReservasVencidas({ horas: 75 }) >= 0, true);
    assert.strictEqual(await stockDe(s, pv.id), 7, "una segunda corrida no repone dos veces");
  });

  test(`${nombre}: pago tardío de una reserva liberada → retoma el cupo si hay; si se agotó avisa (sin overselling)`, opts, async () => {
    const s = get();
    const pv = await preventa(s, 2);
    const [u1, u2] = [await socio(s), await socio(s)];
    const r1 = await s.reservarPreventa(pv.id, u1, 2);
    await envejecer(s, esPg, r1.id, 100);
    await s.liberarReservasVencidas({ horas: 75 });
    assert.strictEqual(await stockDe(s, pv.id), 2);
    const tarde = await s.confirmarReserva(r1.id);
    assert.strictEqual(tarde.estado, "pagada", "había stock: retoma");
    assert.strictEqual(await stockDe(s, pv.id), 0);

    const pv2 = await preventa(s, 2);
    const a = await s.reservarPreventa(pv2.id, u1, 2);
    await envejecer(s, esPg, a.id, 100);
    await s.liberarReservasVencidas({ horas: 75 });
    const b = await s.reservarPreventa(pv2.id, u2, 2); await s.confirmarReserva(b.id);
    const sin = await s.confirmarReserva(a.id);
    assert.strictEqual(sin.error, "sin_stock");
    assert.strictEqual(await stockDe(s, pv2.id), 0, "no se vendió de más");
    assert.strictEqual((await s.getReserva(a.id)).estado, "cancelada");
  });
}
