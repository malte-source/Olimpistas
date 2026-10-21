"use strict";
// Peñas contra Postgres real (TEST_DATABASE_URL): el fondo es plata, así que la atomicidad se prueba de verdad,
// y el mismo escenario corre en memory-store para asegurar que los dos stores se comportan igual.
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
  if (!BASE) return;
  const postgres = require("postgres");
  admin = postgres(BASE, { prepare: false, max: 1, onnotice: () => {} });
  nombreDb = "t_pena_" + crypto.randomBytes(4).toString("hex");
  await admin.unsafe(`CREATE DATABASE ${nombreDb}`);
  sqlMig = postgres(urlDe(nombreDb), { prepare: false, max: 1, onnotice: () => {} });
  await require("../lib/migrar").migrar(sqlMig, { log: {} });
  pg = require("../data/pg-store").createPgStore({ databaseUrl: urlDe(nombreDb) });
  mem = require("../data/memory-store").createMemoryStore({ filePath: null });
});
after(async () => {
  if (!BASE) return;
  try { await pg._sql.end({ timeout: 5 }); } catch (e) {}
  try { await sqlMig.end({ timeout: 5 }); } catch (e) {}
  await admin.unsafe(`DROP DATABASE IF EXISTS ${nombreDb} WITH (FORCE)`).catch(() => {});
  await admin.end({ timeout: 5 });
});

const tag = () => crypto.randomBytes(3).toString("hex");
const nuevaPena = (store, nombre = "Peña Test") => store.crearPena({ nombre: nombre + " " + tag(), ciudad: "Encarnación", pais_iso: "PY", presidente: "P", contacto: "p@ejemplo.com" });
const mkSocio = (store, extra) => store.createSocio({ email: `s-${tag()}@ejemplo.com`, passwordHash: "x", nombre: "Hugo", apellido: "Villalba" , ...extra });
async function pedido(store, socioId, monto = 100000) { return store.createPedidoPago({ socioId, concepto: "Membresía Plus", monto, moneda: "PYG", tierSlug: "premium", ciclo: "anio", refExterna: "h-" + tag() }); }

test("0005: crea las tablas de peñas y las columnas de socios y comercios", opts, async () => {
  const t = (await pg._sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'pena%'`).map((r) => r.table_name).sort();
  assert.deepStrictEqual(t, ["pena_movimientos", "pena_sesiones", "pena_usuarios", "penas"]);
  for (const tabla of ["socios", "comercios"]) {
    const [c] = await pg._sql`SELECT 1 AS x FROM information_schema.columns WHERE table_name = ${tabla} AND column_name = 'pena_id'`;
    assert.ok(c, tabla + ".pena_id");
  }
});

test("pg: slugs únicos aunque se creen peñas con el mismo nombre a la vez", opts, async () => {
  const nombre = "Peña Gemela " + tag();
  const res = await Promise.all(Array.from({ length: 6 }, () => pg.crearPena({ nombre, ciudad: "x", pais_iso: "PY", presidente: "p", contacto: "p@ejemplo.com" })));
  const slugs = res.map((p) => p.slug);
  assert.strictEqual(new Set(slugs).size, 6, "6 slugs distintos: " + slugs.join(","));
});

test("pg: 25 acreditaciones simultáneas del mismo pedido → el fondo suma UNA vez", opts, async () => {
  const p = await nuevaPena(pg), s = await mkSocio(pg), ped = await pedido(pg, s.id);
  const res = await Promise.all(Array.from({ length: 25 }, () => pg.acreditarPena({ penaId: p.id, pedidoId: ped.id, monto: 10000, detalle: "x" })));
  assert.strictEqual(res.filter(Boolean).length, 1);
  assert.strictEqual((await pg.getPena(p.id)).saldo, 10000);
  assert.strictEqual((await pg.movimientosPena(p.id)).length, 1);
});

test("pg: revertir descuenta una sola vez aunque lleguen 10 reversiones", opts, async () => {
  const p = await nuevaPena(pg), s = await mkSocio(pg), ped = await pedido(pg, s.id);
  await pg.acreditarPena({ penaId: p.id, pedidoId: ped.id, monto: 10000 });
  const res = await Promise.all(Array.from({ length: 10 }, () => pg.revertirIngresoPena(ped.id)));
  assert.strictEqual(res.filter(Boolean).length, 1);
  assert.strictEqual((await pg.getPena(p.id)).saldo, 0);
  assert.strictEqual(await pg.revertirIngresoPena("ped_que_no_acredito"), null);
});

test("pg: 8 canjes simultáneos de ₲ 30.000 sobre un fondo de ₲ 100.000 → entran exactamente 3", opts, async () => {
  const p = await nuevaPena(pg), s = await mkSocio(pg), ped = await pedido(pg, s.id);
  await pg.acreditarPena({ penaId: p.id, pedidoId: ped.id, monto: 100000 });
  const res = await Promise.all(Array.from({ length: 8 }, (_, i) => pg.pedirCanjePena({ penaId: p.id, monto: 30000, detalle: "c" + i })));
  assert.strictEqual(res.filter((r) => r && r.ok).length, 3);
  const [fila] = await pg.listPenas({ id: p.id });
  assert.deepStrictEqual({ saldo: fila.saldo, pendiente: fila.canje_pendiente }, { saldo: 100000, pendiente: 90000 });
});

test("pg: aprobar dos veces el mismo canje (10 a la vez) resta una sola vez; rechazar no resta", opts, async () => {
  const p = await nuevaPena(pg), s = await mkSocio(pg), ped = await pedido(pg, s.id);
  await pg.acreditarPena({ penaId: p.id, pedidoId: ped.id, monto: 100000 });
  const a = (await pg.pedirCanjePena({ penaId: p.id, monto: 40000, detalle: "a" })).movimiento.id;
  const b = (await pg.pedirCanjePena({ penaId: p.id, monto: 20000, detalle: "b" })).movimiento.id;
  const res = await Promise.all(Array.from({ length: 10 }, () => pg.resolverCanjePena(a, { aprobar: true })));
  assert.strictEqual(res.filter((r) => r.ok).length, 1);
  assert.strictEqual((await pg.getPena(p.id)).saldo, 60000);
  assert.strictEqual((await pg.resolverCanjePena(b, { aprobar: false })).ok, true);
  assert.strictEqual((await pg.getPena(p.id)).saldo, 60000);
  assert.strictEqual((await pg.resolverCanjePena(b, { aprobar: true })).motivo, "ya_resuelto");
});

test("pg: el saldo nunca queda negativo por aprobar un canje que ya no alcanza", opts, async () => {
  const p = await nuevaPena(pg), s = await mkSocio(pg), ped = await pedido(pg, s.id);
  await pg.acreditarPena({ penaId: p.id, pedidoId: ped.id, monto: 10000 });
  const id = (await pg.pedirCanjePena({ penaId: p.id, monto: 10000, detalle: "todo" })).movimiento.id;
  await pg.revertirIngresoPena(ped.id);
  const r = await pg.resolverCanjePena(id, { aprobar: true });
  assert.deepStrictEqual({ ok: r.ok, motivo: r.motivo }, { ok: false, motivo: "saldo" });
  assert.strictEqual((await pg.getPena(p.id)).saldo, 0);
  assert.strictEqual((await pg.canjesPendientesPena()).filter((c) => c.id === id).length, 1, "sigue pendiente para que el club lo rechace");
});

test("pg: usuario de peña único, token de un solo uso con vencimiento y sesiones con vencimiento", opts, async () => {
  const p = await nuevaPena(pg), usuario = "u-" + tag();
  const u = await pg.crearPenaUsuario({ penaId: p.id, usuario, passwordHash: "h", setupToken: "tk-" + tag(), setupExp: new Date(Date.now() + 3600000).toISOString() });
  await assert.rejects(() => pg.crearPenaUsuario({ penaId: p.id, usuario: usuario.toUpperCase(), passwordHash: "h" }), "usuario repetido");
  assert.strictEqual((await pg.getPenaUsuarioPorSetupToken(u.setup_token)).id, u.id);
  await pg.updatePenaUsuario(u.id, { setup_token: null, setup_exp: null });
  assert.strictEqual(await pg.getPenaUsuarioPorSetupToken(u.setup_token), null, "ya usado");
  await pg.updatePenaUsuario(u.id, { setup_token: "venc-" + tag(), setup_exp: new Date(Date.now() - 1000).toISOString() });
  assert.strictEqual(await pg.getPenaUsuarioPorSetupToken((await pg.getPenaUsuarioDePena(p.id)).setup_token), null, "vencido");
  await pg.crearPenaSesion(p.id, "ses-ok-" + tag(), new Date(Date.now() + 3600000).toISOString());
  const venc = "ses-venc-" + tag();
  await pg._sql`INSERT INTO pena_sesiones (token, pena_id, expira) VALUES (${venc}, ${p.id}, now() - interval '1 minute')`;
  assert.strictEqual(await pg.getPenaSesion(venc), null);
});

test("pg: listPenas cuenta altas, socios validados, Plus/Junior y canje pendiente", opts, async () => {
  const p = await nuevaPena(pg);
  const mk = async (extra, tier) => { const s = await mkSocio(pg); await pg.updateSocio(s.id, { pena_id: p.id, ...extra }); if (tier) await pg.setMembresia(s.id, { tierSlug: tier, ciclo: "anio" }); return s; };
  await mk({}, null); await mk({ es_socio_olimpia: true }, null); await mk({}, "premium"); await mk({}, "kids");
  const ped = await pedido(pg, (await mkSocio(pg)).id); await pg.acreditarPena({ penaId: p.id, pedidoId: ped.id, monto: 50000 });
  await pg.pedirCanjePena({ penaId: p.id, monto: 20000, detalle: "x" });
  const [f] = await pg.listPenas({ id: p.id });
  assert.deepStrictEqual({ altas: f.altas, socios: f.socios, plus: f.plus, saldo: f.saldo, pend: f.canje_pendiente }, { altas: 4, socios: 1, plus: 2, saldo: 50000, pend: 20000 });
  assert.strictEqual((await pg.ultimasAltasPena(p.id, 2)).length, 2);
});

test("contrato pg ↔ memoria: mismo flujo de fondo, mismo resultado", opts, async () => {
  const salidas = [];
  for (const store of [pg, mem]) {
    const p = await nuevaPena(store), s = await mkSocio(store);
    const p1 = await pedido(store, s.id, 100000), p2 = await pedido(store, s.id, 50000);
    const log = [];
    log.push(!!(await store.acreditarPena({ penaId: p.id, pedidoId: p1.id, monto: 10000 })));
    log.push(!!(await store.acreditarPena({ penaId: p.id, pedidoId: p1.id, monto: 10000 })));   // repetido
    log.push(!!(await store.acreditarPena({ penaId: p.id, pedidoId: p2.id, monto: 5000 })));
    const c1 = await store.pedirCanjePena({ penaId: p.id, monto: 9000, detalle: "a" });
    const c2 = await store.pedirCanjePena({ penaId: p.id, monto: 9000, detalle: "b" });         // no alcanza
    log.push(c1.ok, c2.ok, c2.disponible);
    log.push((await store.resolverCanjePena(c1.movimiento.id, { aprobar: true })).ok);
    log.push((await store.resolverCanjePena(c1.movimiento.id, { aprobar: true })).motivo);
    log.push(!!(await store.revertirIngresoPena(p2.id)), !!(await store.revertirIngresoPena(p2.id)));
    const f = (await store.listPenas({ id: p.id }))[0];
    log.push(f.saldo, f.canje_pendiente, (await store.movimientosPena(p.id)).map((m) => m.estado + ":" + m.monto).sort().join("|"));
    salidas.push(log);
  }
  assert.deepStrictEqual(salidas[0], salidas[1]);
  assert.deepStrictEqual(salidas[0].slice(0, 9), [true, false, true, true, false, 6000, true, "ya_resuelto", true]);
});
