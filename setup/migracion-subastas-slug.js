"use strict";
// Agrega `slug` a subastas (link público legible: /subasta/camiseta-tim-payne-a4c en vez
// de /subasta/sub_b8470b...). Idempotente. Backfillea las filas existentes.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-subastas-slug.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

function slugify(titulo, id) {
  const base = String(titulo || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const suf = String(id || "").replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase();
  return (base || "subasta") + (suf ? "-" + suf : "");
}

(async () => {
  await sql`ALTER TABLE subastas ADD COLUMN IF NOT EXISTS slug TEXT`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_subastas_slug ON subastas(slug) WHERE slug IS NOT NULL`;

  const sinSlug = await sql`SELECT id, titulo FROM subastas WHERE slug IS NULL`;
  for (const s of sinSlug) {
    await sql`UPDATE subastas SET slug = ${slugify(s.titulo, s.id)} WHERE id = ${s.id}`;
  }
  console.log(`OK: columna slug + índice. Backfill: ${sinSlug.length} subasta(s).`);
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
