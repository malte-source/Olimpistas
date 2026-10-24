"use strict";
// La API pública de Supabase (anon / authenticated) no debe ver nada de este proyecto: RLS en todas las tablas y sin permisos para esos roles, hoy y para las tablas futuras.
process.env.DB_SSL = "disable";
process.env.OLIMPISTAS_PERSIST = "0";
const BASE = process.env.TEST_DATABASE_URL;
const opts = { skip: BASE ? false : "sin TEST_DATABASE_URL" };

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let admin, nombreDb, sql;
const urlDe = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
before(async () => {
  if (!BASE) return;
  const postgres = require("postgres");
  admin = postgres(BASE, { prepare: false, max: 1, onnotice: () => {} });
  // Supabase trae estos roles; en una base común los creamos para reproducir lo que hace (permisos totales por defecto en public).
  for (const r of ["anon", "authenticated"]) await admin.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`).catch(() => {});
  nombreDb = "t_api_" + crypto.randomBytes(4).toString("hex");
  await admin.unsafe(`CREATE DATABASE ${nombreDb}`);
  sql = postgres(urlDe(nombreDb), { prepare: false, max: 1, onnotice: () => {} });
});
after(async () => {
  if (!BASE) return;
  try { await sql.end({ timeout: 5 }); } catch (e) {}
  await admin.unsafe(`DROP DATABASE IF EXISTS ${nombreDb} WITH (FORCE)`).catch(() => {});
  await admin.end({ timeout: 5 });
});

const estado = async () => {
  const t = await sql`SELECT c.relname AS tabla, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`;
  const [g] = await sql`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')`;
  return { tablas: t.length, sinRls: t.filter((x) => !x.rls).map((x) => x.tabla), permisos: g.n };
};

test("al migrar se cierra todo: RLS en cada tabla y sin permisos para anon ni authenticated", opts, async () => {
  const { migrar } = require("../lib/migrar");
  // como en Supabase: lo que se crea en public queda con permisos totales para los roles de la API
  await sql.unsafe("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated");
  await migrar(sql, { log: {} });
  const e = await estado();
  assert.ok(e.tablas >= 50);
  assert.deepStrictEqual(e.sinRls, [], "todas las tablas con RLS");
  assert.strictEqual(e.permisos, 0, "ningún permiso para anon ni authenticated");
});

test("una tabla creada después queda cerrada en la siguiente corrida, y repetir no cambia nada", opts, async () => {
  const { migrar, cerrarApiPublica } = require("../lib/migrar");
  await sql.unsafe("CREATE TABLE public.tabla_nueva_de_prueba (id int, dato text)");
  await sql.unsafe("GRANT ALL ON public.tabla_nueva_de_prueba TO anon, authenticated");   // lo que haría el valor por defecto de Supabase
  assert.ok((await estado()).sinRls.includes("tabla_nueva_de_prueba"));
  const r = await migrar(sql, { log: {} });
  assert.strictEqual(r.api.rls_activado, 1);
  assert.strictEqual(r.api.permisos_quitados, true);
  const e = await estado();
  assert.deepStrictEqual([e.sinRls, e.permisos], [[], 0]);
  assert.deepStrictEqual(await cerrarApiPublica(sql, {}), { rls_activado: 0, permisos_quitados: false }, "idempotente: sin nada que cerrar no toca nada");
});

test("la app sigue funcionando: el dueño de las tablas (postgres) lee y escribe sin políticas, y anon no ve nada", opts, async () => {
  await sql`INSERT INTO socios (id, email, password_hash, nombre) VALUES ('soc_rls1', 'rls@ejemplo.com', 'x', 'R')`.catch(async () => {
    await sql.unsafe("INSERT INTO socios (id, email, password_hash, nombre, creado) VALUES ('soc_rls1', 'rls@ejemplo.com', 'x', 'R', now())");
  });
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM socios WHERE id = 'soc_rls1'`;
  assert.strictEqual(n, 1, "el rol de la app ve su dato");
  // un rol de la API: sin permisos, la consulta falla
  await sql.unsafe("SET ROLE anon");
  try { await assert.rejects(() => sql.unsafe("SELECT count(*) FROM socios"), /permission denied/i); }
  finally { await sql.unsafe("RESET ROLE"); }
});

test("el runner lo documenta y el CI de seguridad lo exige: la función se exporta y corre en cada migración", () => {
  const m = fs.readFileSync(path.join(__dirname, "..", "lib", "migrar.js"), "utf8");
  assert.ok(/async function cerrarApiPublica/.test(m) && /const api = await cerrarApiPublica\(tx, log\)/.test(m) && /cerrarApiPublica, DIR_DEFAULT/.test(m));
  assert.ok(/ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES/.test(m), "también las tablas futuras");
});
