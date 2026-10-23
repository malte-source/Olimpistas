"use strict";
// Asigna `socios.ciudad_id` a los hinchas que ya tienen una ciudad escrita (o una casa elegida) y ubica las peñas por su ciudad.
// Por defecto SOLO MUESTRA qué haría (agrupado por ciudad escrita); con APLICAR=1 escribe. No toca el texto de `ciudad`.
// Uso:  OLIMPISTAS_DATABASE_URL=... node setup/backfill-ciudades.js          (revisión)
//       OLIMPISTAS_DATABASE_URL=... APLICAR=1 node setup/backfill-ciudades.js (aplica)
(async () => {
  const store = require("../data/store").getStore();
  const sql = store._sql;
  if (!sql) { console.error("Este script es para la base Postgres (falta OLIMPISTAS_DATABASE_URL)."); process.exit(1); }
  const aplicar = process.env.APLICAR === "1";
  if (!(await store.contarCiudades())) { console.error("La tabla `ciudades` está vacía: corré primero setup/importar-ciudades.js"); process.exit(1); }

  // 1) Ciudad escrita → ciudad oficial (por país, sin acentos; se queda con la más poblada).
  const pares = await sql`SELECT upper(pais_iso) AS pais, ciudad, COUNT(*)::int AS n FROM socios WHERE ciudad_id IS NULL AND coalesce(ciudad,'') <> '' AND coalesce(pais_iso,'') <> '' GROUP BY 1, 2 ORDER BY n DESC`;
  let conCiudad = 0, sinCiudad = 0, aplicados = 0; const sin = [];
  for (const p of pares) {
    const c = await store.ciudadPorNombre({ nombre: p.ciudad, pais: p.pais });
    if (!c) { sinCiudad += p.n; sin.push(p); continue; }
    conCiudad += p.n;
    if (aplicar) { const r = await sql`UPDATE socios SET ciudad_id = ${c.id} WHERE upper(pais_iso) = ${p.pais} AND ciudad = ${p.ciudad} AND ciudad_id IS NULL`; aplicados += r.count; }
  }
  console.log(`Por texto de ciudad: ${conCiudad} hinchas coinciden con una ciudad oficial · ${sinCiudad} no (${sin.length} textos distintos)${aplicar ? " · actualizados: " + aplicados : ""}`);
  console.log("Los 25 textos sin coincidencia que más hinchas tienen (para revisar a mano):");
  for (const p of sin.slice(0, 25)) console.log(`  ${String(p.n).padStart(6)}  ${p.pais}  ${p.ciudad}`);

  // 2) Con casa elegida pero sin ciudad: la más cercana del mismo país (hasta 60 km). Las ciudades se cargan una vez en memoria.
  const { masCercana } = require("../lib/ciudades");
  const porPais = {}, todas = [];
  for (const c of await sql`SELECT id, pais_iso, lat, lng FROM ciudades`) { (porPais[c.pais_iso] = porPais[c.pais_iso] || []).push(c); todas.push(c); }
  const casas = await sql`SELECT id, upper(pais_iso) AS pais, lat, lng FROM socios WHERE ciudad_id IS NULL AND lat IS NOT NULL AND lng IS NOT NULL`;
  let porCasa = 0; const porCiudad = new Map();
  for (const s of casas) { const c = masCercana(s.pais ? (porPais[s.pais] || []) : todas, s.lat, s.lng, 60); if (!c) continue; porCasa++; if (!porCiudad.has(c.id)) porCiudad.set(c.id, []); porCiudad.get(c.id).push(s.id); }
  // Una sola sentencia por ciudad (no una por hincha): ~19 mil filas en segundos.
  if (aplicar) for (const [cid, ids] of porCiudad) for (let i = 0; i < ids.length; i += 1000) await sql`UPDATE socios SET ciudad_id = ${cid} WHERE id IN ${sql(ids.slice(i, i + 1000))} AND ciudad_id IS NULL`;
  console.log(`Por casa elegida: ${porCasa} de ${casas.length} hinchas sin ciudad tienen una ciudad oficial a menos de 60 km${aplicar ? " (actualizados)" : ""}`);

  // 3) Peñas sin ubicación: su ciudad.
  const penas = await sql`SELECT id, nombre, ciudad, pais_iso FROM penas WHERE lat IS NULL`;
  let penasOk = 0;
  for (const p of penas) { const c = await store.ciudadPorNombre({ nombre: p.ciudad, pais: p.pais_iso }); if (!c) { console.log(`  peña sin ciudad reconocida: ${p.nombre} (${p.ciudad})`); continue; } penasOk++; if (aplicar) await store.updatePena(p.id, { lat: c.lat, lng: c.lng }); }
  console.log(`Peñas: ${penasOk} de ${penas.length} se pueden ubicar por su ciudad${aplicar ? " (actualizadas)" : ""}`);
  console.log(aplicar ? "LISTO." : "Nada se escribió. Para aplicar: APLICAR=1 node setup/backfill-ciudades.js");
  process.exit(0);
})().catch((e) => { console.error("ERROR: " + e.message); process.exit(1); });
