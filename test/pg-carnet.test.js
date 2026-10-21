"use strict";
// Carnet con QR rotativo y comercio autogestionado contra Postgres real (TEST_DATABASE_URL), y en contrato con memoria.
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
  nombreDb = "t_car_" + crypto.randomBytes(4).toString("hex");
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
const mkSocio = (store) => store.createSocio({ email: `s-${tag()}@ejemplo.com`, passwordHash: "x", nombre: "Hincha" });
const mkComercio = (store, ciudad = "Asunción") => store.crearComercio({ nombre: "Comercio " + tag(), ciudad });
const mkBen = (store, comercioId, extra = {}) => store.crearBeneficio({ comercio_id: comercioId, titulo: "Oferta " + tag(), valor: "10%", pct: 10, ...extra });
const canje = (store, c, b, s, extra = {}) => store.canjearBeneficio({ beneficioId: b.id, socioId: s.id, comercioId: c.id, validadoPor: "caja", monto: 10000, ahorro: 1000, tierSlug: "olimpista", ...extra });

test("0007: columnas nuevas, tabla de usos y lo que ya estaba publicado sigue aprobado", opts, async () => {
  const [t] = await pg._sql`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'carnet_usos'`;
  assert.ok(t);
  for (const [tabla, col] of [["socios", "carnet_secreto"], ["beneficios", "estado"], ["beneficios", "stock"], ["beneficios", "origen"], ["beneficios", "motivo_rechazo"], ["canjes", "tier_slug"]]) {
    const [c] = await pg._sql`SELECT 1 AS x FROM information_schema.columns WHERE table_name = ${tabla} AND column_name = ${col}`;
    assert.ok(c, tabla + "." + col);
  }
  // una base con ofertas ANTERIORES (sin estado) las deja publicadas
  const postgres = require("postgres");
  const db = "t_car07_" + tag();
  await admin.unsafe(`CREATE DATABASE ${db}`);
  const sql = postgres(urlDe(db), { prepare: false, max: 1, onnotice: () => {} });
  try {
    const { migrar, listar } = require("../lib/migrar");
    await sql.unsafe(listar().find((m) => m.id === "0001").sql);
    await sql`INSERT INTO comercios (id, nombre) VALUES ('com_v', 'Viejo')`;
    await sql`INSERT INTO beneficios (id, comercio_id, titulo) VALUES ('ben_v', 'com_v', 'Oferta vieja')`;
    await migrar(sql, { log: {} });
    const [b] = await sql`SELECT estado, origen, stock FROM beneficios WHERE id = 'ben_v'`;
    assert.deepStrictEqual({ estado: b.estado, stock: b.stock }, { estado: "aprobado", stock: null });
  } finally { await sql.end({ timeout: 5 }); await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {}); }
});

test("pg: 20 pedidos simultáneos del primer QR → un solo secreto, el mismo para todos", opts, async () => {
  const s = await mkSocio(pg);
  const res = await Promise.all(Array.from({ length: 20 }, () => pg.asegurarCarnetSecreto(s.id)));
  assert.strictEqual(new Set(res).size, 1);
  assert.strictEqual(res[0].length, 64);
  assert.strictEqual(await pg.getCarnetSecreto(s.id), res[0]);
  assert.strictEqual(await pg.asegurarCarnetSecreto("soc_inexistente"), null);
});

test("pg: 8 cajas a la vez con cupo 1 → se entrega exactamente 1 y el cupo queda en 0", opts, async () => {
  const c = await mkComercio(pg), b = await mkBen(pg, c.id); await pg.updateBeneficio(b.id, { stock: 1 });
  const hs = []; for (let i = 0; i < 8; i++) hs.push(await mkSocio(pg));
  const res = await Promise.all(hs.map((s) => canje(pg, c, b, s)));
  assert.strictEqual(res.filter((r) => r.ok).length, 1);
  assert.strictEqual(res.filter((r) => r.motivo === "agotado").length, 7);
  assert.strictEqual((await pg.getBeneficio(b.id)).stock, 0);
  assert.strictEqual((await pg.estadisticasComercio({ comercioId: c.id, desde: "2000-01-01", hasta: "2100-01-01" })).canjes, 1);
});

test("pg: el mismo QR (misma ventana) usado en 8 cajas a la vez → un solo canje", opts, async () => {
  const c = await mkComercio(pg), b1 = await mkBen(pg, c.id), b2 = await mkBen(pg, c.id), s = await mkSocio(pg);
  const res = await Promise.all(Array.from({ length: 8 }, (_, i) => canje(pg, c, i % 2 ? b1 : b2, s, { ventana: 12345 })));
  assert.strictEqual(res.filter((r) => r.ok).length, 1);
  assert.strictEqual(res.filter((r) => r.motivo === "qr_usado").length, 7);
  const [{ n }] = await pg._sql`SELECT COUNT(*)::int AS n FROM carnet_usos WHERE socio_id = ${s.id}`;
  assert.strictEqual(n, 1);
  assert.ok((await canje(pg, c, b1, s, { ventana: 12346 })).ok, "otra ventana sí");
});

test("pg: un rechazo (límite de días, cupo agotado, oferta pausada) NO consume la ventana del QR", opts, async () => {
  const c = await mkComercio(pg), s = await mkSocio(pg);
  const conLimite = await mkBen(pg, c.id, { limite_dias: 30 }), sinCupo = await mkBen(pg, c.id), pausada = await mkBen(pg, c.id, { activo: false }), libre = await mkBen(pg, c.id);
  await pg.updateBeneficio(sinCupo.id, { stock: 0 });
  assert.ok((await canje(pg, c, conLimite, s, { ventana: 1 })).ok);
  assert.strictEqual((await canje(pg, c, conLimite, s, { ventana: 2 })).motivo, "limite");
  assert.strictEqual((await canje(pg, c, sinCupo, s, { ventana: 2 })).motivo, "agotado");
  assert.strictEqual((await canje(pg, c, pausada, s, { ventana: 2 })).motivo, "beneficio_invalido");
  assert.ok((await canje(pg, c, libre, s, { ventana: 2 })).ok, "la ventana 2 sigue libre después de tres rechazos");
});

test("pg: el límite de días vale aunque dos cajas escaneen al mismo hincha a la vez", opts, async () => {
  const c = await mkComercio(pg), b = await mkBen(pg, c.id, { limite_dias: 7 }), s = await mkSocio(pg);
  const res = await Promise.all(Array.from({ length: 6 }, (_, i) => canje(pg, c, b, s, { ventana: 100 + i })));
  assert.strictEqual(res.filter((r) => r.ok).length, 1);
});

test("pg: una oferta de otro comercio, en borrador o rechazada no se puede canjear", opts, async () => {
  const c1 = await mkComercio(pg), c2 = await mkComercio(pg), s = await mkSocio(pg);
  const ajena = await mkBen(pg, c2.id), borrador = await pg.crearBeneficioComercio({ comercioId: c1.id, titulo: "Borrador " + tag(), valor: "5%" });
  assert.strictEqual((await canje(pg, c1, ajena, s)).motivo, "beneficio_invalido");
  assert.strictEqual(borrador.estado, "borrador");
  assert.strictEqual((await canje(pg, c1, borrador, s)).motivo, "beneficio_invalido");
  await pg.resolverOferta(borrador.id, { estado: "rechazado", motivo: "no" });
  assert.strictEqual((await canje(pg, c1, borrador, s)).motivo, "beneficio_invalido");
  const ok = await pg.resolverOferta(borrador.id, { estado: "aprobado" });
  assert.deepStrictEqual({ estado: ok.estado, motivo: ok.motivo_rechazo, activo: ok.activo }, { estado: "aprobado", motivo: null, activo: true });
  assert.ok((await canje(pg, c1, borrador, s)).ok);
});

test("pg: las ofertas sin aprobar no aparecen para el hincha ni en la lista de caja; una aprobada sí", opts, async () => {
  const c = await mkComercio(pg), b = await pg.crearBeneficioComercio({ comercioId: c.id, titulo: "Pendiente " + tag(), valor: "5%" });
  const ids = async () => ({ hincha: (await pg.beneficiosParaNivel("olimpista")).map((x) => x.id), caja: (await pg.beneficiosDeComercio(c.id)).map((x) => x.id), todas: (await pg.ofertasDeComercio(c.id)).map((x) => x.id) });
  let r = await ids();
  assert.ok(!r.hincha.includes(b.id) && !r.caja.includes(b.id) && r.todas.includes(b.id));
  await pg.resolverOferta(b.id, { estado: "aprobado" });
  r = await ids();
  assert.ok(r.hincha.includes(b.id) && r.caja.includes(b.id));
});

test("pg: updateBeneficioComercio solo toca las ofertas de ese comercio", opts, async () => {
  const c1 = await mkComercio(pg), c2 = await mkComercio(pg), b = await mkBen(pg, c1.id);
  assert.strictEqual(await pg.updateBeneficioComercio(b.id, c2.id, { activo: false }), null);
  assert.strictEqual((await pg.getBeneficio(b.id)).activo, true);
  assert.strictEqual((await pg.updateBeneficioComercio(b.id, c1.id, { activo: false })).activo, false);
});

// ── Estadísticas: mismo escenario en pg y en memoria ─────────────────────────
async function escenarioStats(store) {
  const c = await mkComercio(store, "Luque"), b = await mkBen(store, c.id, { limite_dias: null });
  const datos = [["premium", 100000, 10000], ["premium", 50000, 5000], ["olimpista", null, 2000], ["socio", 30000, 3000]];
  for (const [tier, monto, ahorro] of datos) await canje(store, c, b, await mkSocio(store), { tierSlug: tier, monto, ahorro });
  return { c, b };
}
test("contrato pg ↔ memoria: estadísticas del comercio, mix por nivel, CSV y reporte de sponsors", opts, async () => {
  const salidas = [];
  for (const store of [pg, mem]) {
    const { c, b } = await escenarioStats(store);
    const rango = { desde: new Date(Date.now() - 3600000).toISOString(), hasta: new Date(Date.now() + 3600000).toISOString() };
    const e = await store.estadisticasComercio({ comercioId: c.id, ...rango });
    const fuera = await store.estadisticasComercio({ comercioId: c.id, desde: "2000-01-01T00:00:00Z", hasta: "2000-02-01T00:00:00Z" });
    const filas = await store.canjesDeComercio({ comercioId: c.id, ...rango });
    const sp = (await store.estadisticasPorComercio(rango)).filter((x) => x.comercio === c.nombre);
    salidas.push({
      canjes: e.canjes, ahorro: e.ahorro, ventas: e.ventas, ticket: e.ticket_promedio,
      mix: Object.fromEntries(e.mix.map((m) => [m.nivel, m.canjes])), fuera: fuera.canjes,
      csv: filas.map((f) => [f.nivel, f.monto, f.ahorro, f.beneficio === b.titulo]).sort().join("|"),
      sponsors: sp.map((x) => [x.ciudad, x.nivel, x.canjes, Number(x.ahorro), Number(x.ventas)].join(":")).sort().join("|"),
    });
  }
  assert.deepStrictEqual(salidas[0], salidas[1], "pg y memoria deben dar lo mismo");
  assert.deepStrictEqual({ c: salidas[0].canjes, a: salidas[0].ahorro, v: salidas[0].ventas, t: salidas[0].ticket }, { c: 4, a: 20000, v: 180000, t: 60000 });
  assert.deepStrictEqual(salidas[0].mix, { premium: 2, olimpista: 1, socio: 1 });
});

test("pg: un canje sin nivel guardado (anterior a esta función) cuenta como 'sin_dato' en el mix", opts, async () => {
  const c = await mkComercio(pg), b = await mkBen(pg, c.id), s = await mkSocio(pg);
  await pg._sql`INSERT INTO canjes (id, beneficio_id, socio_id, comercio_id, monto, ahorro) VALUES (${"cnj_" + tag()}, ${b.id}, ${s.id}, ${c.id}, 1000, 100)`;
  const e = await pg.estadisticasComercio({ comercioId: c.id, desde: "2000-01-01T00:00:00Z", hasta: "2100-01-01T00:00:00Z" });
  assert.deepStrictEqual(e.mix, [{ nivel: "sin_dato", canjes: 1 }]);
});

test("pg: el período usa días de Paraguay (un canje a las 23:30 locales del último día entra en ese día)", opts, async () => {
  const { periodo } = require("../lib/periodo");
  const c = await mkComercio(pg), b = await mkBen(pg, c.id), s = await mkSocio(pg);
  // 2026-09-30 23:30 en Paraguay (UTC-3) = 2026-10-01 02:30 UTC
  await pg._sql`INSERT INTO canjes (id, beneficio_id, socio_id, comercio_id, ahorro, creado) VALUES (${"cnj_" + tag()}, ${b.id}, ${s.id}, ${c.id}, 500, '2026-10-01T02:30:00Z')`;
  const sep = periodo({ desde: "2026-09-01", hasta: "2026-09-30" }), oct = periodo({ desde: "2026-10-01", hasta: "2026-10-31" });
  assert.strictEqual((await pg.estadisticasComercio({ comercioId: c.id, desde: sep.desde, hasta: sep.hasta })).canjes, 1, "cuenta en septiembre");
  assert.strictEqual((await pg.estadisticasComercio({ comercioId: c.id, desde: oct.desde, hasta: oct.hasta })).canjes, 0, "no en octubre");
});
