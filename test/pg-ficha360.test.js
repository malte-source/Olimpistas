"use strict";
// Sprint 1 — billetera, Ficha 360 y segmentos contra Postgres real (TEST_DATABASE_URL) y en
// contrato con memory-store: mismos datos, mismo resultado.
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
  nombreDb = "t_f360_" + crypto.randomBytes(4).toString("hex");
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

const HORA = 3600000, DIA = 24 * HORA;
const tag = () => crypto.randomBytes(3).toString("hex");
const mkSocio = (store, nombre = "T") => store.createSocio({ email: `${nombre}-${tag()}@ejemplo.com`, passwordHash: "x", nombre });
// Inicio del mes / año actual en hora de Paraguay (UTC-3).
const inicioMesPy = () => { const L = new Date(Date.now() - 3 * HORA); return Date.UTC(L.getUTCFullYear(), L.getUTCMonth(), 1) + 3 * HORA; };
const inicioAnioPy = () => Date.UTC(new Date(Date.now() - 3 * HORA).getUTCFullYear(), 0, 1) + 3 * HORA;

const ben = new Map();
async function beneficioDe(store) {
  if (!ben.has(store)) {
    const c = await store.crearComercio({ nombre: "Comercio de prueba " + tag() });
    const b = await store.crearBeneficio({ comercio_id: c.id, titulo: "10% de descuento" });
    ben.set(store, { comercioId: c.id, beneficioId: b.id });
  }
  return ben.get(store);
}
async function sembrarAhorro(store, esPg) {
  const s = await mkSocio(store, "ah");
  const poner = async (ahorro, ms) => {
    const b = await beneficioDe(store);
    const c = await store.registrarCanje({ beneficioId: b.beneficioId, socioId: s.id, comercioId: b.comercioId, validadoPor: "t", monto: ahorro * 5, ahorro });
    if (esPg) await pg._sql`UPDATE canjes SET creado = ${new Date(ms).toISOString()} WHERE id = ${c.id}`; else c.creado = new Date(ms).toISOString();
  };
  await poner(10000, Date.now());
  await poner(5000, inicioMesPy() + 60000);
  await poner(7000, inicioMesPy() - 60000);        // el último minuto del mes anterior en Paraguay
  await poner(3000, inicioAnioPy() - 30 * DIA);    // el año anterior
  return s;
}

test("contrato pg ↔ memoria: billetera con los bordes del mes y del año en hora de Paraguay", opts, async () => {
  const a = await pg.resumenAhorroSocio((await sembrarAhorro(pg, true)).id);
  const b = await mem.resumenAhorroSocio((await sembrarAhorro(mem, false)).id);
  assert.deepStrictEqual(a, b, "pg y memoria dan lo mismo");
  assert.strictEqual(a.mes, 15000);
  assert.strictEqual(a.canjes_mes, 2);
  assert.strictEqual(a.total, 25000);
});

test("contrato pg ↔ memoria: pujasDeSocio resume por lote (mejor oferta, cantidad de pujas, estado)", opts, async () => {
  const salida = [];
  for (const store of [pg, mem]) {
    const A = await mkSocio(store, "pa"), B = await mkSocio(store, "pb");
    const lote = await store.crearSubasta({ titulo: "Lote ficha", estado: "activa", termina: new Date(Date.now() + HORA).toISOString(), precio_inicial: 100000, incremento: 10000 });
    await store.pujar({ subastaId: lote.id, socioId: A.id, monto: 120000 });
    await store.pujar({ subastaId: lote.id, socioId: B.id, monto: 130000 });
    await store.pujar({ subastaId: lote.id, socioId: A.id, monto: 140000 });
    const p = (await store.pujasDeSocio(A.id))[0];
    salida.push({ titulo: p.titulo, mejor: p.mejor_oferta, pujas: p.pujas, estado: p.estado, gana: p.ganador_id === A.id });
  }
  assert.deepStrictEqual(salida[0], salida[1]);
  assert.deepStrictEqual(salida[0], { titulo: "Lote ficha", mejor: 140000, pujas: 2, estado: "activa", gana: true });
});

test("contrato pg ↔ memoria: filtros nuevos del segmento (canjes, pujas, gasto, ciudad, excluir)", opts, async () => {
  const resultados = [];
  for (const store of [pg, mem]) {
    const t = tag();
    const mk = async (nombre, extra) => { const s = await store.createSocio({ email: `${nombre}-${t}@ejemplo.com`, passwordHash: "x", nombre: nombre + t }); await store.updateSocio(s.id, { pais_iso: "CL", ...extra }); return s; };
    const A = await mk("a", { ciudad: "Santiago", gasto_total: 5000, pais_iso: "C" + t.slice(0, 1).toUpperCase() }), B = await mk("b", { ciudad: "Santiago" }), C = await mk("c", { ciudad: "Valparaiso" });
    // país único por corrida para no mezclar con datos de otros tests
    const pais = "Z" + t.slice(0, 1).toUpperCase();
    for (const s of [A, B, C]) await store.updateSocio(s.id, { pais_iso: pais });
    const bb = await beneficioDe(store);
    await store.registrarCanje({ beneficioId: bb.beneficioId, socioId: A.id, comercioId: bb.comercioId, validadoPor: "t", monto: 1, ahorro: 1 });
    const lote = await store.crearSubasta({ titulo: "L", estado: "activa", termina: new Date(Date.now() + HORA).toISOString(), precio_inicial: 1000, incremento: 100 });
    await store.pujar({ subastaId: lote.id, socioId: B.id, monto: 1100 });
    const nombres = async (f) => {
      const ids = (await store.filtrarSocios({ paisIso: pais, ...f, limit: 100 })).map((s) => s.id);
      return [["a", A], ["b", B], ["c", C]].filter(([, s]) => ids.includes(s.id)).map(([n]) => n).join(",");
    };
    resultados.push({
      todos: await nombres({}), conCanjes: await nombres({ canjes: true }), sinCanjes: await nombres({ canjes: false }),
      conPujas: await nombres({ pujas: true }), sinPujas: await nombres({ pujas: false }),
      conGasto: await nombres({ gasto: true }), sinGasto: await nombres({ gasto: false }),
      santiago: await nombres({ ciudad: "santiago" }), sinA: await nombres({ excluirId: A.id }),
    });
  }
  assert.deepStrictEqual(resultados[0], resultados[1], "pg y memoria filtran igual");
  assert.deepStrictEqual(resultados[0], { todos: "a,b,c", conCanjes: "a", sinCanjes: "b,c", conPujas: "b", sinPujas: "a,c", conGasto: "a", sinGasto: "b,c", santiago: "a,b", sinA: "b,c" });
});

async function pedidoDe(store, monto) {
  const s = await mkSocio(store, "gasto");
  return store.createPedidoPago({ socioId: s.id, concepto: "Membresía Plus", monto, moneda: "PYG", tierSlug: "premium", ciclo: "anio", refExterna: "h-" + tag() });
}

test("pg: el gasto suma una vez por pedido (25 entregas simultáneas) y la reversión lo descuenta una vez", opts, async () => {
  const p = await pedidoDe(pg, 180000);
  const antes = (await pg.getSocioById(p.socio_id)).gasto_total;
  await pg.reclamarCumplimiento(p.id);
  const res = await Promise.all(Array.from({ length: 25 }, () => pg.marcarCumplido(p.id)));
  assert.strictEqual(res.filter(Boolean).length, 1);
  assert.strictEqual((await pg.getSocioById(p.socio_id)).gasto_total, antes + 180000);
  await Promise.all(Array.from({ length: 10 }, () => pg.marcarReversado(p.id)));
  assert.strictEqual((await pg.getSocioById(p.socio_id)).gasto_total, antes, "descontado una sola vez");
});

test("pg: revertir un pedido que nunca se entregó no descuenta nada", opts, async () => {
  const p = await pedidoDe(pg, 90000);
  await pg._sql`UPDATE pedidos_pago SET estado = 'pagado' WHERE id = ${p.id}`; // pagado pero sin cumplir
  const antes = (await pg.getSocioById(p.socio_id)).gasto_total;
  await pg.marcarReversado(p.id);
  assert.strictEqual((await pg.getSocioById(p.socio_id)).gasto_total, antes);
});

test("contrato pg ↔ memoria: gasto_total acompaña a la entrega y a la reversión", opts, async () => {
  const salida = [];
  for (const store of [pg, mem]) {
    const p = await pedidoDe(store, 120000);
    await store.reclamarCumplimiento(p.id);
    await store.marcarCumplido(p.id);
    const tras = (await store.getSocioById(p.socio_id)).gasto_total;
    await store.marcarReversado(p.id);
    salida.push({ tras, fin: (await store.getSocioById(p.socio_id)).gasto_total });
  }
  assert.deepStrictEqual(salida[0], salida[1]);
  assert.deepStrictEqual(salida[0], { tras: 120000, fin: 0 });
});

test("pg: segmentos guardados — filtros JSON de ida y vuelta", opts, async () => {
  const s = await pg.crearSegmento({ nombre: "Plus de Chile", filtros: { tier: "premium", paisIso: "CL", canjes: true }, por: "malte" });
  const guardado = (await pg.listSegmentos()).find((x) => x.id === s.id);
  assert.deepStrictEqual(guardado.filtros, { tier: "premium", paisIso: "CL", canjes: true });
  await pg.deleteSegmento(s.id);
  assert.ok(!(await pg.listSegmentos()).some((x) => x.id === s.id));
});

test("pg: tocarActividad actualiza la fecha", opts, async () => {
  const s = await mkSocio(pg, "act");
  await pg._sql`UPDATE socios SET ultima_actividad = now() - interval '3 days' WHERE id = ${s.id}`;
  await pg.tocarActividad(s.id);
  const [r] = await pg._sql`SELECT (now() - ultima_actividad) < interval '1 minute' AS reciente FROM socios WHERE id = ${s.id}`;
  assert.strictEqual(r.reciente, true);
});

test("0004: gasto_total sale de lo ya pagado y ultima_actividad parte del alta", opts, async () => {
  const postgres = require("postgres");
  const db = "t_f360m_" + crypto.randomBytes(3).toString("hex");
  await admin.unsafe(`CREATE DATABASE ${db}`);
  const sql = postgres(urlDe(db), { prepare: false, max: 1, onnotice: () => {} });
  try {
    const { migrar, listar } = require("../lib/migrar");
    await sql.unsafe(listar().find((m) => m.id === "0001").sql);
    await sql`INSERT INTO socios (id, email, password_hash) VALUES ('soc_a', 'a@ejemplo.com', 'x'), ('soc_b', 'b@ejemplo.com', 'x')`;
    await sql`INSERT INTO pedidos_pago (id, socio_id, concepto, monto, estado) VALUES
      ('p1','soc_a','x',180000,'pagado'), ('p2','soc_a','y',80000,'pagado'), ('p3','soc_a','z',50000,'pendiente'), ('p4','soc_b','w',99000,'reversado')`;
    await migrar(sql, { log: {} });
    const [a] = await sql`SELECT gasto_total, ultima_actividad, creado FROM socios WHERE id='soc_a'`;
    const [b] = await sql`SELECT gasto_total FROM socios WHERE id='soc_b'`;
    assert.strictEqual(a.gasto_total, 260000, "solo suma lo pagado");
    assert.strictEqual(b.gasto_total, 0, "un pago reversado no cuenta");
    assert.strictEqual(a.ultima_actividad.getTime(), a.creado.getTime());
  } finally { await sql.end({ timeout: 5 }); await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {}); }
});
