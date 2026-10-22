"use strict";
// Carga (o actualiza) la tabla `ciudades` desde GeoNames cities15000.txt (CC-BY 4.0 · https://www.geonames.org). Idempotente.
// Uso:  OLIMPISTAS_DATABASE_URL=... node setup/importar-ciudades.js ruta/a/cities15000.txt [ruta/a/PY.txt]
//       (el segundo archivo es opcional: el volcado completo de un país, de https://download.geonames.org/export/dump/PY.zip,
//        suma sus pueblos de menos de 15.000 habitantes)
//       (bajar el archivo de https://download.geonames.org/export/dump/cities15000.zip y descomprimirlo)
const fs = require("fs");
const { parsearGeonames, parsearLocalidades } = require("../lib/ciudades");
(async () => {
  const archivo = process.argv[2];
  if (!archivo || !fs.existsSync(archivo)) { console.error("Uso: node setup/importar-ciudades.js ruta/a/cities15000.txt"); process.exit(1); }
  const filas = parsearGeonames(fs.readFileSync(archivo, "utf8"));
  // Ciudades que GeoNames trae sin población (y por eso quedan fuera de cities15000) pero que tienen miles de hinchas.
  // La población de este archivo es una estimación y solo ordena las sugerencias del autocompletado.
  const pais = process.argv[3];
  if (pais) {
    if (!fs.existsSync(pais)) { console.error("No existe " + pais); process.exit(1); }
    const vistos = new Set(filas.map((x) => x.id)); let sumadas = 0;
    for (const f of parsearLocalidades(fs.readFileSync(pais, "utf8"))) if (!vistos.has(f.id)) { filas.push(f); vistos.add(f.id); sumadas++; }
    console.log("Localidades del país sumadas: " + sumadas);
  }
  const extraArchivo = require("path").join(__dirname, "..", "data", "ciudades-extra.json");
  if (fs.existsSync(extraArchivo)) {
    for (const e of JSON.parse(fs.readFileSync(extraArchivo, "utf8"))) {
      const fila = { id: e.id, nombre: e.nombre, nombre_norm: require("../lib/ciudades").norm(e.nombre), pais_iso: e.pais_iso, lat: e.lat, lng: e.lng, poblacion: e.poblacion || 0 };
      const i = filas.findIndex((x) => x.id === fila.id); if (i >= 0) filas[i] = fila; else filas.push(fila);
    }
  }
  if (filas.length < 1000) { console.error("El archivo no parece cities15000.txt (" + filas.length + " filas válidas)."); process.exit(1); }
  const store = require("../data/store").getStore();
  const n = await store.importarCiudades(filas);
  console.log("OK: " + n + " ciudades cargadas/actualizadas · total en la base: " + (await store.contarCiudades()));
  process.exit(0);
})().catch((e) => { console.error("ERROR: " + e.message); process.exit(1); });
