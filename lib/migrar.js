"use strict";

/**
 * lib/migrar.js — ejecutor de migraciones SQL versionadas.
 *
 * Archivos `migraciones/NNNN_nombre.sql`, en orden. Cada una corre UNA vez y queda
 * registrada en `schema_migrations` con su checksum. Todo el lote pendiente corre en UNA
 * transacción con un advisory lock: si hay varias instancias arrancando, solo una migra y
 * el resto espera; si algo falla, no queda nada a medias.
 *
 *  - Base vacía  → corre 0001_base (el esquema completo) y las que siguen.
 *  - Producción  → ya tiene el esquema sin historial: 0001 se registra SIN ejecutarla
 *                  ("baseline") y corren solo las posteriores.
 *  - Un archivo ya aplicado que cambió (checksum distinto) es un error: las migraciones
 *    aplicadas no se editan, se agrega una nueva.
 *
 * Reglas para escribirlas: aditivas primero (el código viejo debe seguir andando con el
 * esquema nuevo, porque la migración corre ANTES del deploy), sin SET de sesión (pasan por
 * el pooler) y sin BEGIN/COMMIT propios.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR_DEFAULT = path.join(__dirname, "..", "migraciones");
const LOCK_ID = 7272740001; // arbitrario pero fijo para todo el proyecto
const BASELINE = "0001";

function listar(dir = DIR_DEFAULT) {
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const texto = fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");
      return { id: f.slice(0, 4), nombre: f, sql: texto, checksum: crypto.createHash("sha256").update(texto).digest("hex") };
    });
}

/**
 * @param sql   cliente de postgres.js
 * @param opts  { dir, log, soloVer, tolerarDesconocidas } — soloVer=true calcula el plan sin tocar nada;
 *              tolerarDesconocidas=true deja arrancar un código viejo (rollback) sobre una base más nueva
 * @returns     { aplicadas:[ids], baseline:bool, pendientes:[ids] }
 */
async function migrar(sql, { dir, log = console, soloVer = false, tolerarDesconocidas = false } = {}) {
  const archivos = listar(dir);
  if (!archivos.length) throw new Error("no hay migraciones en " + (dir || DIR_DEFAULT));
  const ids = archivos.map((a) => a.id);
  if (new Set(ids).size !== ids.length) throw new Error("migraciones con número repetido: " + ids.join(", "));

  if (soloVer) {
    const [{ existe }] = await sql`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS existe`;
    const hechas = existe ? await sql`SELECT id, checksum FROM schema_migrations` : [];
    return planear(archivos, hechas, await tieneEsquema(sql), tolerarDesconocidas);
  }

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      id text PRIMARY KEY, nombre text NOT NULL, checksum text NOT NULL, aplicada timestamptz NOT NULL DEFAULT now())`;
    const hechas = await tx`SELECT id, checksum FROM schema_migrations`;
    const plan = planear(archivos, hechas, await tieneEsquema(tx), tolerarDesconocidas);

    if (plan.baseline) {
      const base = archivos.find((a) => a.id === BASELINE);
      await tx`INSERT INTO schema_migrations (id, nombre, checksum) VALUES (${base.id}, ${base.nombre}, ${base.checksum})`;
      log.info && log.info({ migracion: base.nombre }, "migraciones: esquema existente registrado como base (no se ejecuta)");
    }
    for (const id of plan.pendientes) {
      const m = archivos.find((a) => a.id === id);
      const t0 = Date.now();
      await tx.unsafe(m.sql);
      await tx`INSERT INTO schema_migrations (id, nombre, checksum) VALUES (${m.id}, ${m.nombre}, ${m.checksum})`;
      log.info && log.info({ migracion: m.nombre, ms: Date.now() - t0 }, "migraciones: aplicada");
    }
    const api = await cerrarApiPublica(tx, log);
    return { aplicadas: plan.pendientes, baseline: plan.baseline, pendientes: [], api };
  });
}

/**
 * Cierra la API pública de Supabase (PostgREST) a TODO lo de este proyecto, siempre. Olimpistas se conecta directo a la base con el rol `postgres` (que ignora RLS)
 * y no usa la API pública; dejarla abierta expone cada tabla (sesiones del panel, hashes de contraseña, padrón) a quien tenga la clave anon.
 *  · RLS activado en todas las tablas de public (sin políticas = la API no ve nada);
 *  · se quitan los permisos de `anon` y `authenticated` sobre tablas, secuencias y funciones, y también los que recibirían las tablas futuras.
 * Es idempotente y barato (mira antes de tocar), y corre en cada migración: una tabla nueva queda cerrada sin acordarse de nada.
 * En una base común (sin esos roles) solo activa RLS. Las tablas nuevas NO necesitan GRANT: la app no usa la API.
 */
async function cerrarApiPublica(sql, log = console) {
  const sinRls = await sql`SELECT c.relname AS tabla FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity ORDER BY 1`;
  for (const { tabla } of sinRls) await sql.unsafe(`ALTER TABLE public."${String(tabla).replace(/"/g, '""')}" ENABLE ROW LEVEL SECURITY`);
  const roles = (await sql`SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`).map((r) => r.rolname);
  let revocados = false;
  if (roles.length) {
    const lista = roles.map((r) => `"${r}"`).join(", ");
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = ANY(${roles})`;
    const [{ f }] = await sql`SELECT count(*)::int AS f FROM information_schema.routine_privileges WHERE routine_schema = 'public' AND grantee = ANY(${roles})`;
    if (n > 0 || f > 0) {
      await sql.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${lista}`);
      await sql.unsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${lista}`);
      await sql.unsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${lista}`);
      revocados = true;
    }
    await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${lista}`);
    await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${lista}`);
    await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM ${lista}`);
  }
  if ((sinRls.length || revocados) && log.info) log.info({ rls_activado: sinRls.length, permisos_quitados: revocados }, "migraciones: API pública cerrada");
  return { rls_activado: sinRls.length, permisos_quitados: revocados };
}

async function tieneEsquema(sql) {
  const [{ existe }] = await sql`SELECT to_regclass('public.socios') IS NOT NULL AS existe`;
  return existe;
}

// Decide qué falta, sin ejecutar nada (la usa también el modo "solo ver").
function planear(archivos, hechas, hayEsquema, tolerarDesconocidas = false) {
  const porId = new Map(hechas.map((h) => [h.id, h.checksum]));
  let baseline = false;
  if (!porId.size && hayEsquema) { baseline = true; porId.set(BASELINE, archivos.find((a) => a.id === BASELINE).checksum); }
  for (const a of archivos) {
    if (porId.has(a.id) && porId.get(a.id) !== a.checksum)
      throw new Error(`la migración ${a.nombre} ya estaba aplicada y su contenido cambió — las aplicadas no se editan, agregá una nueva`);
  }
  const conocidas = new Set(archivos.map((a) => a.id));
  for (const id of porId.keys()) {
    if (!conocidas.has(id) && !tolerarDesconocidas) throw new Error(`la base tiene la migración ${id} que este código no conoce (¿deploy de una versión más vieja?)`);
  }
  const pendientes = archivos.filter((a) => !porId.has(a.id)).map((a) => a.id);
  return { baseline, pendientes, aplicadas: [] };
}

module.exports = { migrar, listar, planear, cerrarApiPublica, DIR_DEFAULT };
