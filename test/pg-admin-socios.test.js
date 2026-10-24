"use strict";
// Tabla de socios del panel: la misma consulta en Postgres real y en memoria devuelve lo mismo (filtros, total, orden y páginas).
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
  nombreDb = "t_asoc_" + crypto.randomBytes(4).toString("hex");
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

async function sembrar(store) {
  const mk = async (nombre, apellido, extra = {}, tier) => {
    const s = await store.createSocio({ email: `${nombre.toLowerCase()}@ejemplo.com`, passwordHash: "x", nombre, apellido });
    await store.updateSocio(s.id, extra);
    if (tier) await store.setMembresia(s.id, { tierSlug: tier, ciclo: "anio" });
    return s;
  };
  await mk("Ana", "Zapata", { ciudad: "Asunción", email_verificado: true, es_socio_olimpia: true, cedula: "1000001" }, "socio");
  await mk("Beto", "Alvarez", { ciudad: "Luque", email_verificado: false, cedula: "1000002" }, "premium");
  await mk("Carla", "Mendez", { ciudad: "Asunción", email_verificado: true, cedula: "1000003" });
  await mk("Dario", "Benitez", { ciudad: "Encarnación", email_verificado: false, es_socio_olimpia: true, cedula: "1000004" }, "socio");
}
const resumen = (r) => ({ total: r.total, nombres: r.items.map((x) => x.nombre) });

test("misma página, total, filtros y orden en Postgres y en memoria", opts, async () => {
  await sembrar(pg); await sembrar(mem);
  const casos = [
    [{}, { total: 4, nombres: ["Dario", "Carla", "Beto", "Ana"] }],                                   // por defecto: más nuevos primero
    [{ orden: "nombre", dir: "asc" }, { total: 4, nombres: ["Beto", "Dario", "Carla", "Ana"] }],        // por apellido: Alvarez, Benitez, Mendez, Zapata
    [{ orden: "nombre", dir: "desc" }, { total: 4, nombres: ["Ana", "Carla", "Dario", "Beto"] }],
    [{ tier: "socio" }, { total: 2, nombres: ["Dario", "Ana"] }],
    [{ club: true }, { total: 2, nombres: ["Dario", "Ana"] }],
    [{ club: false }, { total: 2, nombres: ["Carla", "Beto"] }],
    [{ verificado: true }, { total: 2, nombres: ["Carla", "Ana"] }],
    [{ verificado: false }, { total: 2, nombres: ["Dario", "Beto"] }],
    [{ ciudad: "asunción", orden: "nombre", dir: "asc" }, { total: 2, nombres: ["Carla", "Ana"] }],
    [{ q: "1000002" }, { total: 1, nombres: ["Beto"] }],
    [{ q: "zapata" }, { total: 1, nombres: ["Ana"] }],
    [{ limite: 2, pagina: 0, orden: "nombre", dir: "asc" }, { total: 4, nombres: ["Beto", "Dario"] }],
    [{ limite: 2, pagina: 1, orden: "nombre", dir: "asc" }, { total: 4, nombres: ["Carla", "Ana"] }],
    [{ limite: 2, pagina: 9 }, { total: 4, nombres: [] }],
  ];
  for (const [f, esperado] of casos) {
    // `creado` es el mismo instante para varios: el desempate por id hace estable solo el orden por nombre; para el orden por defecto se compara como conjunto.
    const p = resumen(await pg.paginaSocios(f)), m = resumen(await mem.paginaSocios(f));
    assert.strictEqual(p.total, esperado.total, JSON.stringify(f) + " (pg total)");
    assert.strictEqual(m.total, esperado.total, JSON.stringify(f) + " (mem total)");
    if (f.orden || f.limite) { assert.deepStrictEqual(p.nombres, esperado.nombres, JSON.stringify(f) + " (pg)"); assert.deepStrictEqual(m.nombres, esperado.nombres, JSON.stringify(f) + " (mem)"); }
    else { assert.deepStrictEqual([...p.nombres].sort(), [...esperado.nombres].sort(), JSON.stringify(f)); assert.deepStrictEqual([...m.nombres].sort(), [...esperado.nombres].sort(), JSON.stringify(f)); }
  }
});

test("el tope por página es 100, un orden desconocido no rompe y el nivel sale de la membresía vigente", opts, async () => {
  const r = await pg.paginaSocios({ limite: 5000, orden: "contraseña; DROP TABLE socios" });
  assert.strictEqual(r.limite, 100);
  assert.strictEqual(r.total, 4, "la tabla sigue ahí");
  const ana = r.items.find((x) => x.nombre === "Ana");
  assert.strictEqual(ana.tier_slug, "socio");
  assert.strictEqual(r.items.find((x) => x.nombre === "Carla").tier_slug, "olimpista", "sin membresía paga: Olimpista");
  assert.ok(!("password_hash" in ana) && !("foto" in ana), "la tabla nunca trae la contraseña ni la foto");
});
