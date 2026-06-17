"use strict";

/**
 * paises.js — Catálogo ISO-3166 alpha-2 → { nombre (es), lat, lng } (centroide).
 *
 * Se usa para:
 *  - Prefill / selector de país en el perfil.
 *  - Ubicar la bandera de Olimpia en el globo (cuando el socio no fijó punto exacto).
 *
 * Lista amplia (Américas, Europa, y los principales de Asia/África/Oceanía).
 * Extender libremente: agregar { iso: { nombre, lat, lng } }.
 */

const PAISES = {
  PY: { nombre: "Paraguay", lat: -23.44, lng: -58.44 },
  AR: { nombre: "Argentina", lat: -38.42, lng: -63.62 },
  BR: { nombre: "Brasil", lat: -14.24, lng: -51.93 },
  UY: { nombre: "Uruguay", lat: -32.52, lng: -55.77 },
  BO: { nombre: "Bolivia", lat: -16.29, lng: -63.59 },
  CL: { nombre: "Chile", lat: -35.68, lng: -71.54 },
  PE: { nombre: "Perú", lat: -9.19, lng: -75.02 },
  CO: { nombre: "Colombia", lat: 4.57, lng: -74.30 },
  EC: { nombre: "Ecuador", lat: -1.83, lng: -78.18 },
  VE: { nombre: "Venezuela", lat: 6.42, lng: -66.59 },
  MX: { nombre: "México", lat: 23.63, lng: -102.55 },
  US: { nombre: "Estados Unidos", lat: 37.09, lng: -95.71 },
  CA: { nombre: "Canadá", lat: 56.13, lng: -106.35 },
  CR: { nombre: "Costa Rica", lat: 9.75, lng: -83.75 },
  PA: { nombre: "Panamá", lat: 8.54, lng: -80.78 },
  GT: { nombre: "Guatemala", lat: 15.78, lng: -90.23 },
  HN: { nombre: "Honduras", lat: 15.20, lng: -86.24 },
  SV: { nombre: "El Salvador", lat: 13.79, lng: -88.90 },
  NI: { nombre: "Nicaragua", lat: 12.87, lng: -85.21 },
  DO: { nombre: "Rep. Dominicana", lat: 18.74, lng: -70.16 },
  CU: { nombre: "Cuba", lat: 21.52, lng: -77.78 },
  PR: { nombre: "Puerto Rico", lat: 18.22, lng: -66.59 },
  ES: { nombre: "España", lat: 40.46, lng: -3.75 },
  PT: { nombre: "Portugal", lat: 39.40, lng: -8.22 },
  IT: { nombre: "Italia", lat: 41.87, lng: 12.57 },
  FR: { nombre: "Francia", lat: 46.23, lng: 2.21 },
  DE: { nombre: "Alemania", lat: 51.17, lng: 10.45 },
  GB: { nombre: "Reino Unido", lat: 55.38, lng: -3.44 },
  IE: { nombre: "Irlanda", lat: 53.41, lng: -8.24 },
  NL: { nombre: "Países Bajos", lat: 52.13, lng: 5.29 },
  BE: { nombre: "Bélgica", lat: 50.50, lng: 4.47 },
  CH: { nombre: "Suiza", lat: 46.82, lng: 8.23 },
  AT: { nombre: "Austria", lat: 47.52, lng: 14.55 },
  SE: { nombre: "Suecia", lat: 60.13, lng: 18.64 },
  NO: { nombre: "Noruega", lat: 60.47, lng: 8.47 },
  DK: { nombre: "Dinamarca", lat: 56.26, lng: 9.50 },
  FI: { nombre: "Finlandia", lat: 61.92, lng: 25.75 },
  PL: { nombre: "Polonia", lat: 51.92, lng: 19.15 },
  CZ: { nombre: "Chequia", lat: 49.82, lng: 15.47 },
  RO: { nombre: "Rumania", lat: 45.94, lng: 24.97 },
  GR: { nombre: "Grecia", lat: 39.07, lng: 21.82 },
  RU: { nombre: "Rusia", lat: 61.52, lng: 105.32 },
  UA: { nombre: "Ucrania", lat: 48.38, lng: 31.17 },
  TR: { nombre: "Turquía", lat: 38.96, lng: 35.24 },
  IL: { nombre: "Israel", lat: 31.05, lng: 34.85 },
  AE: { nombre: "Emiratos Árabes", lat: 23.42, lng: 53.85 },
  SA: { nombre: "Arabia Saudita", lat: 23.89, lng: 45.08 },
  CN: { nombre: "China", lat: 35.86, lng: 104.20 },
  JP: { nombre: "Japón", lat: 36.20, lng: 138.25 },
  KR: { nombre: "Corea del Sur", lat: 35.91, lng: 127.77 },
  IN: { nombre: "India", lat: 20.59, lng: 78.96 },
  ID: { nombre: "Indonesia", lat: -0.79, lng: 113.92 },
  PH: { nombre: "Filipinas", lat: 12.88, lng: 121.77 },
  TH: { nombre: "Tailandia", lat: 15.87, lng: 100.99 },
  VN: { nombre: "Vietnam", lat: 14.06, lng: 108.28 },
  AU: { nombre: "Australia", lat: -25.27, lng: 133.78 },
  NZ: { nombre: "Nueva Zelanda", lat: -40.90, lng: 174.89 },
  ZA: { nombre: "Sudáfrica", lat: -30.56, lng: 22.94 },
  EG: { nombre: "Egipto", lat: 26.82, lng: 30.80 },
  MA: { nombre: "Marruecos", lat: 31.79, lng: -7.09 },
  NG: { nombre: "Nigeria", lat: 9.08, lng: 8.68 },
  AO: { nombre: "Angola", lat: -11.20, lng: 17.87 },
};

function paisNombre(iso) { return (PAISES[iso] && PAISES[iso].nombre) || iso; }
function paisCentroide(iso) { return PAISES[iso] || null; }
function listaPaises() {
  return Object.entries(PAISES)
    .map(([iso, p]) => ({ iso, nombre: p.nombre }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

module.exports = { PAISES, paisNombre, paisCentroide, listaPaises };
