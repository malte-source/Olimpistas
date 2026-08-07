"use strict";
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 1, prepare: false, ssl: "require" });
const dom = "%@demo.olimpistas.test";
(async () => {
  const [a] = await sql`SELECT COUNT(*)::int n FROM socios WHERE email NOT LIKE ${dom}`;
  const [b] = await sql`SELECT COUNT(*)::int n FROM socios WHERE email NOT LIKE ${dom} AND pais_iso <> ''`;
  const [c] = await sql`SELECT COUNT(*)::int n FROM socios WHERE email NOT LIKE ${dom} AND pais <> '' AND (pais_iso = '' OR pais_iso IS NULL)`;
  console.log("socios reales:", a.n);
  console.log("con pais_iso (van al mapa):", b.n);
  console.log("con texto pais pero SIN pais_iso (NO van al mapa):", c.n);
  const filas = await sql`SELECT nombre, apellido, pais, pais_iso FROM socios WHERE email NOT LIKE ${dom} ORDER BY creado DESC LIMIT 12`;
  console.log("--- últimos reales ---");
  filas.forEach((f) => console.log((f.nombre || "") + " " + (f.apellido || ""), "| pais:", f.pais || "-", "| iso:", f.pais_iso || "(VACÍO)"));
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
