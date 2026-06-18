"use strict";
/**
 * seed-demo.js — Distribución mundial de Olimpistas para la demo, con CANTIDADES
 * REALES por país (provistas por negocio) y reparto lógico por ciudad.
 *
 * Enfoque ESCALABLE (no mete 1M de filas):
 *   1) Tabla `demo_agregado` (~90 filas): pais_iso, ciudad, lat, lng, count.
 *      El contador y el globo leen de acá (sumado a los miembros reales).
 *   2) Casas opt-in (~1.800 filas en `socios`, mostrar_exacto=true): para el
 *      efecto "bandera en tu casa" al hacer zoom. No cuentan en el total.
 *
 * Uso:
 *   node setup/seed-demo.js                 → DRY-RUN (imprime el plan)
 *   OLIMPISTAS_DATABASE_URL=... node setup/seed-demo.js --apply   → aplica (reemplaza)
 *   node setup/seed-demo.js --reset         → borra agregado + casas de demo
 */
const crypto = require("crypto");
const SEED_DOMAIN = "demo.olimpistas.test";

// ── Proporciones por país (referencia real). Se escalan al TOTAL_OBJETIVO. ──
const PAIS_TOTAL = {
  PY: 1024501, AR: 7809, BR: 5009, ES: 4055, US: 2509, JP: 234, MX: 210,
  CO: 128, IT: 84, CA: 74, PE: 44, AU: 43, SE: 28, DE: 22, NZ: 21, VE: 18,
  CL: 14, PT: 11, TR: 11, RU: 2, EC: 1,
};
// Total mundial objetivo (escala las proporciones de arriba). 1M era exagerado.
const TOTAL_OBJETIVO = Number(process.env.SEED_TOTAL || 180000);
// Escala PAIS_TOTAL al objetivo manteniendo proporciones (mín. 1 por país; ajuste a PY).
function paisTotales() {
  const sum = Object.values(PAIS_TOTAL).reduce((s, v) => s + v, 0);
  const out = {}; let acc = 0, bigIso = "PY", bigVal = -1;
  for (const [iso, v] of Object.entries(PAIS_TOTAL)) {
    out[iso] = Math.max(1, Math.round((v / sum) * TOTAL_OBJETIVO));
    acc += out[iso];
    if (v > bigVal) { bigVal = v; bigIso = iso; }
  }
  out[bigIso] += TOTAL_OBJETIVO - acc; // clava el total exacto
  return out;
}

// ── Ciudades por país con peso relativo (reparte el total del país) ─────────
//    [iso, ciudad, lat, lng, peso]
const CIUDADES = [
  // ════ PARAGUAY (1.024.501) — 17 departamentos + capital ════
  ["PY", "Asunción", -25.2637, -57.5759, 100],
  ["PY", "San Lorenzo", -25.3397, -57.5089, 42],
  ["PY", "Luque", -25.2700, -57.4870, 36],
  ["PY", "Capiatá", -25.3553, -57.4456, 33],
  ["PY", "Lambaré", -25.3450, -57.6100, 26],
  ["PY", "Fernando de la Mora", -25.3300, -57.5400, 24],
  ["PY", "Limpio", -25.1681, -57.4900, 20],
  ["PY", "Ñemby", -25.3950, -57.5360, 18],
  ["PY", "Mariano Roque Alonso", -25.2050, -57.5330, 15],
  ["PY", "Itauguá", -25.3922, -57.3539, 14],
  ["PY", "Villa Elisa", -25.3640, -57.5910, 14],
  ["PY", "J. Augusto Saldívar", -25.4500, -57.4300, 11],
  ["PY", "San Antonio", -25.4167, -57.6000, 9],
  ["PY", "Areguá", -25.3050, -57.3850, 8],
  ["PY", "Itá", -25.5100, -57.3700, 8],
  ["PY", "Ypané", -25.5050, -57.5250, 7],
  ["PY", "Guarambaré", -25.4900, -57.4500, 6],
  ["PY", "Villeta", -25.5100, -57.5500, 6],
  ["PY", "Ciudad del Este", -25.5097, -54.6111, 46],
  ["PY", "Presidente Franco", -25.5500, -54.6100, 13],
  ["PY", "Hernandarias", -25.4050, -54.6400, 11],
  ["PY", "Minga Guazú", -25.4900, -54.8200, 9],
  ["PY", "Santa Rita", -25.8000, -55.0500, 5],
  ["PY", "Encarnación", -27.3306, -55.8667, 22],
  ["PY", "Cambyretá", -27.3000, -55.8200, 5],
  ["PY", "Hohenau", -27.0833, -55.7500, 3],
  ["PY", "Coronel Bogado", -27.1700, -56.2500, 3],
  ["PY", "Coronel Oviedo", -25.4500, -56.4400, 12],
  ["PY", "Caaguazú", -25.4636, -56.0156, 10],
  ["PY", "Campo 9", -25.3500, -55.7500, 5],
  ["PY", "Santaní", -24.6500, -56.4400, 6],
  ["PY", "San Pedro de Ycuamandyyú", -24.0900, -57.0800, 4],
  ["PY", "Caacupé", -25.3858, -57.1419, 8],
  ["PY", "Tobatí", -25.2500, -57.0800, 4],
  ["PY", "Eusebio Ayala", -25.3800, -56.9300, 3],
  ["PY", "Piribebuy", -25.4700, -57.0000, 3],
  ["PY", "Villarrica", -25.7833, -56.4333, 9],
  ["PY", "Paraguarí", -25.6219, -57.1453, 5],
  ["PY", "Carapeguá", -25.7900, -57.2400, 4],
  ["PY", "Ybycuí", -26.0167, -56.9333, 2],
  ["PY", "Concepción", -23.4064, -57.4344, 9],
  ["PY", "Pedro Juan Caballero", -22.5470, -55.7330, 14],
  ["PY", "Salto del Guairá", -24.0600, -54.3100, 4],
  ["PY", "Curuguaty", -24.5167, -55.6900, 4],
  ["PY", "Caazapá", -26.1972, -56.3711, 3],
  ["PY", "San Juan Bautista", -26.6678, -57.1469, 4],
  ["PY", "Santa Rosa", -26.8700, -56.8500, 2],
  ["PY", "Pilar", -26.8597, -58.2992, 5],
  ["PY", "Villa Hayes", -25.0900, -57.5240, 4],
  ["PY", "Benjamín Aceval", -24.9667, -57.5667, 2],
  ["PY", "Filadelfia", -22.3500, -60.0300, 4],
  ["PY", "Loma Plata", -22.3800, -59.8400, 3],
  ["PY", "Mariscal Estigarribia", -22.0300, -60.6100, 2],
  ["PY", "Fuerte Olimpo", -21.0419, -57.8739, 1],
  // ════ ARGENTINA (7.809) — BsAs + frontera (colectividad paraguaya) ════
  ["AR", "Buenos Aires", -34.6037, -58.3816, 100],
  ["AR", "Formosa", -26.1775, -58.1781, 30],
  ["AR", "Clorinda", -25.2853, -57.7197, 24],
  ["AR", "Córdoba", -31.4201, -64.1888, 22],
  ["AR", "Rosario", -32.9442, -60.6505, 18],
  ["AR", "Posadas", -27.3671, -55.8961, 20],
  ["AR", "Resistencia", -27.4514, -58.9867, 12],
  // ════ BRASIL (5.009) ════
  ["BR", "São Paulo", -23.5505, -46.6333, 40],
  ["BR", "Foz do Iguaçu", -25.5163, -54.5854, 38],
  ["BR", "Ponta Porã", -22.5296, -55.7203, 28],
  ["BR", "Curitiba", -25.4284, -49.2733, 14],
  ["BR", "Rio de Janeiro", -22.9068, -43.1729, 12],
  ["BR", "Brasília", -15.7939, -47.8828, 8],
  // ════ ESPAÑA (4.055) ════
  ["ES", "Madrid", 40.4168, -3.7038, 100],
  ["ES", "Barcelona", 41.3851, 2.1734, 75],
  ["ES", "Valencia", 39.4699, -0.3763, 26],
  ["ES", "Málaga", 36.7213, -4.4214, 18],
  ["ES", "Bilbao", 43.2630, -2.9350, 14],
  // ════ ESTADOS UNIDOS (2.509) ════
  ["US", "Miami", 25.7617, -80.1918, 100],
  ["US", "New York", 40.7128, -74.0060, 60],
  ["US", "Los Angeles", 34.0522, -118.2437, 40],
  ["US", "Houston", 29.7604, -95.3698, 26],
  ["US", "Chicago", 41.8781, -87.6298, 22],
  ["US", "Washington DC", 38.9072, -77.0369, 18],
  // ════ JAPÓN (234) — comunidad dekasegi ════
  ["JP", "Tokio", 35.6762, 139.6503, 60],
  ["JP", "Nagoya", 35.1815, 136.9066, 40],
  // ════ MÉXICO (210) ════
  ["MX", "Ciudad de México", 19.4326, -99.1332, 100],
  ["MX", "Guadalajara", 20.6597, -103.3496, 30],
  // ════ COLOMBIA (128) ════
  ["CO", "Bogotá", 4.7110, -74.0721, 100],
  ["CO", "Medellín", 6.2442, -75.5812, 35],
  // ════ ITALIA (84) ════
  ["IT", "Milán", 45.4642, 9.1900, 100],
  ["IT", "Roma", 41.9028, 12.4964, 70],
  ["IT", "Turín", 45.0703, 7.6869, 28],
  // ════ CANADÁ (74) ════
  ["CA", "Toronto", 43.6532, -79.3832, 100],
  ["CA", "Montreal", 45.5017, -73.5673, 45],
  // ════ PERÚ (44) ════
  ["PE", "Lima", -12.0464, -77.0428, 100],
  // ════ AUSTRALIA (43) ════
  ["AU", "Sídney", -33.8688, 151.2093, 100],
  ["AU", "Melbourne", -37.8136, 144.9631, 55],
  // ════ SUECIA (28) ════
  ["SE", "Estocolmo", 59.3293, 18.0686, 100],
  // ════ ALEMANIA (22) ════
  ["DE", "Berlín", 52.5200, 13.4050, 100],
  ["DE", "Frankfurt", 50.1109, 8.6821, 55],
  // ════ NUEVA ZELANDA (21) ════
  ["NZ", "Auckland", -36.8485, 174.7633, 100],
  // ════ VENEZUELA (18) ════
  ["VE", "Caracas", 10.4806, -66.9036, 100],
  // ════ CHILE (14) ════
  ["CL", "Santiago", -33.4489, -70.6693, 100],
  ["CL", "Antofagasta", -23.6509, -70.3975, 18],
  // ════ PORTUGAL (11) ════
  ["PT", "Lisboa", 38.7223, -9.1393, 100],
  // ════ TURQUÍA (11) ════
  ["TR", "Estambul", 41.0082, 28.9784, 100],
  // ════ RUSIA (2) ════
  ["RU", "Moscú", 55.7558, 37.6173, 100],
  // ════ ECUADOR (1) ════
  ["EC", "Quito", -0.1807, -78.4678, 100],
];

// ── Casas opt-in de demo (~1.800, punto exacto a nivel domicilio) ───────────
const CASAS_TOTAL = Number(process.env.SEED_CASAS || 1800);
const BARRIOS = [
  ["PY", "Asunción", "Villa Morra", -25.2940, -57.5760, 10],
  ["PY", "Asunción", "Recoleta", -25.2890, -57.5860, 9],
  ["PY", "Asunción", "Las Mercedes", -25.2980, -57.6000, 8],
  ["PY", "Asunción", "Sajonia", -25.3060, -57.6360, 8],
  ["PY", "Asunción", "Carmelitas", -25.2820, -57.5700, 7],
  ["PY", "Asunción", "Mariscal López", -25.3000, -57.5650, 7],
  ["PY", "Asunción", "San Roque", -25.2890, -57.6300, 6],
  ["PY", "Asunción", "Trinidad", -25.2720, -57.5840, 6],
  ["PY", "Luque", "Centro", -25.2700, -57.4870, 7],
  ["PY", "San Lorenzo", "Centro", -25.3397, -57.5089, 7],
  ["PY", "Lambaré", "Centro", -25.3450, -57.6100, 6],
  ["PY", "Ciudad del Este", "Centro", -25.5097, -54.6111, 8],
  ["PY", "Encarnación", "Centro", -27.3306, -55.8667, 5],
  ["AR", "Buenos Aires", "Palermo", -34.5790, -58.4270, 6],
  ["BR", "Foz do Iguaçu", "Centro", -25.5163, -54.5854, 5],
  ["ES", "Madrid", "Centro", 40.4200, -3.7050, 5],
];

const NOMBRES = ["Juan","José","Carlos","Luis","Miguel","Diego","Sergio","Marcos","Fernando","Rodrigo",
  "Gustavo","Hugo","Pablo","Andrés","Cristian","Víctor","Óscar","Iván","Alejandro","Ramón",
  "María","Lucía","Sofía","Camila","Romina","Liz","Patricia","Carolina","Gabriela","Fátima",
  "Larissa","Belén","Tamara","Rocío","Mariana","Daniela","Verónica","Antonella","Cynthia","Noelia"];
const APELLIDOS = ["González","Benítez","Martínez","Rodríguez","López","Giménez","Ramírez","Fernández",
  "Villalba","Cáceres","Ortiz","Ayala","Romero","Acosta","Duarte","Vera","Rojas","Núñez","Franco",
  "Insfrán","Espínola","Aquino","Britez","Mendoza","Riveros","Sosa","Maciel","Ovelar","Báez","Centurión"];

const PAIS_NOMBRE = require("../data/paises").paisNombre;

// Reparte el total exacto de cada país entre sus ciudades (resto → ciudad principal).
function planificarAgregado() {
  const porPais = {};
  for (const c of CIUDADES) (porPais[c[0]] = porPais[c[0]] || []).push(c);
  const filas = [];
  for (const [iso, total] of Object.entries(paisTotales())) {
    const ciudades = porPais[iso];
    if (!ciudades) { console.error("⚠ Sin ciudades para", iso); continue; }
    const pesoSum = ciudades.reduce((s, c) => s + c[4], 0);
    let asignado = 0;
    const rows = ciudades.map((c) => {
      const n = Math.round((c[4] / pesoSum) * total);
      asignado += n;
      return { pais_iso: iso, ciudad: c[1], lat: c[2], lng: c[3], count: n };
    });
    rows[0].count += total - asignado; // cuadra exacto al total del país
    filas.push(...rows.filter((r) => r.count > 0));
  }
  return filas;
}

function planificarCasas() {
  const pesoSum = BARRIOS.reduce((s, b) => s + b[5], 0);
  let asignado = 0;
  const plan = BARRIOS.map((b) => {
    const n = Math.round((b[5] / pesoSum) * CASAS_TOTAL);
    asignado += n;
    return { iso: b[0], ciudad: b[1], barrio: b[2], lat: b[3], lng: b[4], n };
  });
  plan[0].n += CASAS_TOTAL - asignado;
  return plan;
}

function imprimirPlan(agg) {
  const total = agg.reduce((s, r) => s + r.count, 0);
  console.log(`\n=== DISTRIBUCIÓN (agregado: ${total.toLocaleString("es-PY")} Olimpistas en ${agg.length} ciudades) ===\n`);
  const porPais = {};
  for (const r of agg) porPais[r.pais_iso] = (porPais[r.pais_iso] || 0) + r.count;
  console.log("Por país:");
  Object.entries(porPais).sort((a, b) => b[1] - a[1]).forEach(([iso, n]) =>
    console.log(`  ${iso}  ${String(n.toLocaleString("es-PY")).padStart(11)}  ${((n/total)*100).toFixed(1).padStart(5)}%  ${PAIS_NOMBRE(iso)}`));
  const py = agg.filter((r) => r.pais_iso === "PY").sort((a, b) => b.count - a.count);
  console.log(`\nParaguay: ${py.length} ciudades. Top 8:`);
  py.slice(0, 8).forEach((r) => console.log(`  ${String(r.count.toLocaleString("es-PY")).padStart(9)}  ${r.ciudad}`));
  const casas = planificarCasas();
  console.log(`\n🚩 Casas opt-in (zoom): ${casas.reduce((s,b)=>s+b.n,0).toLocaleString("es-PY")} en ${casas.length} barrios.`);
}

// Variable normal (Box-Muller) → nube circular suave alrededor del centro (sin cuadrados).
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  let g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-2.6, Math.min(2.6, g)); // recorta outliers extremos
}
function* generarCasas(planCasas) {
  const HASH = "$2b$10$seedSEEDseedSEEDseedSEuJ8c9Qm0wTq3aXk1pYqZr5sT2vW6yC";
  let i = 0;
  for (const b of planCasas) {
    // sigma variable por barrio → unos más extendidos que otros (más natural)
    const sigma = 0.013 + (i % 5) * 0.0018; // ~1.4–2.4 km
    for (let k = 0; k < b.n; k++) {
      const nombre = `${NOMBRES[(i * 11 + k) % NOMBRES.length]} ${APELLIDOS[(i * 5 + k * 7) % APELLIDOS.length]}`;
      yield {
        id: "seed_" + crypto.randomBytes(7).toString("hex"),
        email: `casa.${i}@${SEED_DOMAIN}`,
        password_hash: HASH, nombre,
        pais: PAIS_NOMBRE(b.iso), pais_iso: b.iso, ciudad: b.ciudad,
        lat: +(b.lat + gauss() * sigma).toFixed(6),
        lng: +(b.lng + gauss() * sigma * 1.08).toFixed(6), // lng un poco más ancho (cos lat)
        mostrar_exacto: true,
      };
      i++;
    }
  }
}

async function conectar() {
  const url = (process.env.OLIMPISTAS_DATABASE_URL || "").trim();
  if (!/^postgres(ql)?:\/\//.test(url)) {
    console.error("\n✖ Falta OLIMPISTAS_DATABASE_URL (o no es URL postgres). No toco nada.");
    process.exit(1);
  }
  return require("postgres")(url, { max: 5, idle_timeout: 20, prepare: false, ssl: "require" });
}

async function borrarSeeds(sql) {
  await sql`CREATE TABLE IF NOT EXISTS demo_agregado (
    pais_iso TEXT NOT NULL, ciudad TEXT NOT NULL DEFAULT '',
    lat DOUBLE PRECISION, lng DOUBLE PRECISION, count INTEGER NOT NULL DEFAULT 0)`;
  await sql`TRUNCATE demo_agregado`;
  const r = await sql`DELETE FROM socios WHERE email LIKE ${"%@" + SEED_DOMAIN}`;
  console.log(`Limpiado: demo_agregado vaciado, ${r.count} casas/seeds previos borrados.`);
}

async function aplicar(agg) {
  const sql = await conectar();
  try {
    await borrarSeeds(sql);
    // 1) Agregado por ciudad (contador + globo)
    for (let i = 0; i < agg.length; i += 500) {
      await sql`INSERT INTO demo_agregado ${sql(agg.slice(i, i + 500), "pais_iso", "ciudad", "lat", "lng", "count")}`;
    }
    const [a] = await sql`SELECT COUNT(*)::int filas, COALESCE(SUM(count),0)::bigint total FROM demo_agregado`;
    console.log(`✔ demo_agregado: ${a.filas} ciudades, total ${Number(a.total).toLocaleString("es-PY")}`);
    // 2) Casas opt-in en socios
    const casas = []; for (const f of generarCasas(planificarCasas())) casas.push(f);
    const COLS = ["id", "email", "password_hash", "nombre", "pais", "pais_iso", "ciudad", "lat", "lng", "mostrar_exacto"];
    for (let i = 0; i < casas.length; i += 1000) {
      await sql`INSERT INTO socios ${sql(casas.slice(i, i + 1000), ...COLS)}`;
    }
    console.log(`✔ casas opt-in: ${casas.length} insertadas en socios.`);
  } finally { await sql.end({ timeout: 5 }); }
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes("--reset")) {
    const sql = await conectar();
    try { await borrarSeeds(sql); console.log("✔ Reset hecho."); }
    finally { await sql.end({ timeout: 5 }); }
    return;
  }
  const agg = planificarAgregado();
  imprimirPlan(agg);
  if (args.includes("--apply")) { console.log("\n→ Aplicando…"); await aplicar(agg); }
  else { console.log("\n(DRY-RUN) Agregá --apply para escribir. Limpieza: --reset"); }
})().catch((e) => { console.error("✖ Error:", e.message); process.exit(1); });
