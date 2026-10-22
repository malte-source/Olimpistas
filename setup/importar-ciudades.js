"use strict";
// Carga (o actualiza) la tabla `ciudades` desde GeoNames cities15000.txt (CC-BY 4.0 · https://www.geonames.org). Idempotente.
// Uso:  OLIMPISTAS_DATABASE_URL=... node setup/importar-ciudades.js ruta/a/cities15000.txt
//       (bajar el archivo de https://download.geonames.org/export/dump/cities15000.zip y descomprimirlo)
const fs = require("fs");
const { parsearGeonames } = require("../lib/ciudades");
(async () => {
  const archivo = process.argv[2];
  if (!archivo || !fs.existsSync(archivo)) { console.error("Uso: node setup/importar-ciudades.js ruta/a/cities15000.txt"); process.exit(1); }
  const filas = parsearGeonames(fs.readFileSync(archivo, "utf8"));
  if (filas.length < 1000) { console.error("El archivo no parece cities15000.txt (" + filas.length + " filas válidas)."); process.exit(1); }
  const store = require("../data/store").getStore();
  const n = await store.importarCiudades(filas);
  console.log("OK: " + n + " ciudades cargadas/actualizadas · total en la base: " + (await store.contarCiudades()));
  process.exit(0);
})().catch((e) => { console.error("ERROR: " + e.message); process.exit(1); });
