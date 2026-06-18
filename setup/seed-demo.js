"use strict";
/**
 * seed-demo.js — Carga ~150.000 Olimpistas DE PRUEBA con distribución mundial
 * realista para Club Olimpia (Paraguay dominante + diáspora + cola global).
 *
 * Los datos alimentan el contador global y el globo (banderas por ciudad).
 *
 * Uso:
 *   node setup/seed-demo.js                 → DRY-RUN: imprime el plan, no toca la DB
 *   OLIMPISTAS_DATABASE_URL=... node setup/seed-demo.js --apply   → inserta
 *
 * Limpieza (borra SOLO las filas de prueba, jamás miembros reales):
 *   node setup/seed-demo.js --reset
 *
 * Marca: todas las filas usan email "...@demo.olimpistas.test".
 */
const crypto = require("crypto");

const TOTAL = Number(process.env.SEED_TOTAL || 150000);
const SEED_DOMAIN = "demo.olimpistas.test";

// Ciudades reales con coords y PESO relativo (no porcentaje; se normaliza a TOTAL).
// El peso modela la realidad de la hinchada de Olimpia: Paraguay manda, después la
// diáspora paraguaya (Argentina, Brasil frontera, España, USA) y una cola mundial.
const CIUDADES = [
  // ── Paraguay (núcleo, ~58%) ──────────────────────────────────────────────
  ["PY", "Asunción", -25.2637, -57.5759, 2300],
  ["PY", "Ciudad del Este", -25.5097, -54.6111, 950],
  ["PY", "San Lorenzo", -25.3397, -57.5089, 620],
  ["PY", "Luque", -25.2700, -57.4870, 520],
  ["PY", "Capiatá", -25.3553, -57.4456, 430],
  ["PY", "Lambaré", -25.3450, -57.6100, 380],
  ["PY", "Fernando de la Mora", -25.3300, -57.5400, 360],
  ["PY", "Limpio", -25.1681, -57.4900, 250],
  ["PY", "Ñemby", -25.3950, -57.5360, 230],
  ["PY", "Encarnación", -27.3306, -55.8667, 420],
  ["PY", "Mariano Roque Alonso", -25.2050, -57.5330, 200],
  ["PY", "Itauguá", -25.3922, -57.3539, 180],
  ["PY", "Villa Elisa", -25.3640, -57.5910, 190],
  ["PY", "Pedro Juan Caballero", -22.5470, -55.7330, 260],
  ["PY", "Coronel Oviedo", -25.4500, -56.4400, 220],
  ["PY", "Caaguazú", -25.4636, -56.0156, 180],
  ["PY", "Villarrica", -25.7833, -56.4333, 160],
  ["PY", "Concepción", -23.4064, -57.4344, 160],
  ["PY", "Caacupé", -25.3858, -57.1419, 130],
  ["PY", "Pilar", -26.8597, -58.2992, 110],
  ["PY", "Paraguarí", -25.6219, -57.1453, 100],
  ["PY", "San Juan Bautista", -26.6678, -57.1469, 80],
  // ── Argentina (diáspora paraguaya enorme, ~13%) ──────────────────────────
  ["AR", "Buenos Aires", -34.6037, -58.3816, 1150],
  ["AR", "Córdoba", -31.4201, -64.1888, 300],
  ["AR", "Rosario", -32.9442, -60.6505, 270],
  ["AR", "Formosa", -26.1775, -58.1781, 320],
  ["AR", "Clorinda", -25.2853, -57.7197, 240],
  ["AR", "Posadas", -27.3671, -55.8961, 230],
  ["AR", "Resistencia", -27.4514, -58.9867, 170],
  ["AR", "La Plata", -34.9215, -57.9545, 120],
  ["AR", "Mendoza", -32.8895, -68.8458, 90],
  // ── Brasil (frontera + grandes ciudades, ~7%) ────────────────────────────
  ["BR", "São Paulo", -23.5505, -46.6333, 430],
  ["BR", "Foz do Iguaçu", -25.5163, -54.5854, 420],
  ["BR", "Ponta Porã", -22.5296, -55.7203, 300],
  ["BR", "Curitiba", -25.4284, -49.2733, 180],
  ["BR", "Rio de Janeiro", -22.9068, -43.1729, 150],
  ["BR", "Brasília", -15.7939, -47.8828, 110],
  // ── España (gran comunidad migrante, ~6%) ────────────────────────────────
  ["ES", "Madrid", 40.4168, -3.7038, 560],
  ["ES", "Barcelona", 41.3851, 2.1734, 430],
  ["ES", "Valencia", 39.4699, -0.3763, 160],
  ["ES", "Málaga", 36.7213, -4.4214, 120],
  ["ES", "Bilbao", 43.2630, -2.9350, 90],
  // ── Estados Unidos (~5%) ─────────────────────────────────────────────────
  ["US", "Miami", 25.7617, -80.1918, 360],
  ["US", "New York", 40.7128, -74.0060, 240],
  ["US", "Los Angeles", 34.0522, -118.2437, 160],
  ["US", "Houston", 29.7604, -95.3698, 110],
  ["US", "Chicago", 41.8781, -87.6298, 90],
  ["US", "Washington DC", 38.9072, -77.0369, 80],
  // ── Resto de América Latina (cola, ~5%) ──────────────────────────────────
  ["UY", "Montevideo", -34.9011, -56.1645, 180],
  ["BO", "Santa Cruz de la Sierra", -17.7833, -63.1821, 200],
  ["BO", "La Paz", -16.5000, -68.1500, 90],
  ["CL", "Santiago", -33.4489, -70.6693, 170],
  ["PE", "Lima", -12.0464, -77.0428, 140],
  ["CO", "Bogotá", 4.7110, -74.0721, 130],
  ["EC", "Quito", -0.1807, -78.4678, 80],
  ["VE", "Caracas", 10.4806, -66.9036, 80],
  ["MX", "Ciudad de México", 19.4326, -99.1332, 170],
  ["CR", "San José", 9.9281, -84.0907, 60],
  ["PA", "Ciudad de Panamá", 8.9824, -79.5199, 70],
  ["DO", "Santo Domingo", 18.4861, -69.9312, 60],
  // ── Europa (cola, ~3%) ───────────────────────────────────────────────────
  ["IT", "Milán", 45.4642, 9.1900, 170],
  ["IT", "Roma", 41.9028, 12.4964, 130],
  ["FR", "París", 48.8566, 2.3522, 150],
  ["DE", "Berlín", 52.5200, 13.4050, 110],
  ["DE", "Frankfurt", 50.1109, 8.6821, 80],
  ["GB", "Londres", 51.5074, -0.1278, 140],
  ["PT", "Lisboa", 38.7223, -9.1393, 90],
  ["CH", "Zúrich", 47.3769, 8.5417, 70],
  ["NL", "Ámsterdam", 52.3676, 4.9041, 60],
  ["BE", "Bruselas", 50.8503, 4.3517, 50],
  ["SE", "Estocolmo", 59.3293, 18.0686, 40],
  // ── Resto del mundo (presencia simbólica, ~1.5%) ─────────────────────────
  ["CA", "Toronto", 43.6532, -79.3832, 110],
  ["AU", "Sídney", -33.8688, 151.2093, 90],
  ["JP", "Tokio", 35.6762, 139.6503, 60],
  ["AE", "Dubái", 25.2048, 55.2708, 50],
  ["IL", "Tel Aviv", 32.0853, 34.7818, 40],
  ["ZA", "Johannesburgo", -26.2041, 28.0473, 30],
  ["NZ", "Auckland", -36.8485, 174.7633, 25],
  ["CN", "Shanghái", 31.2304, 121.4737, 30],
  ["KR", "Seúl", 37.5665, 126.9780, 25],
];

const NOMBRES = ["Juan","José","Carlos","Luis","Miguel","Diego","Sergio","Marcos","Fernando","Rodrigo",
  "Gustavo","Hugo","Pablo","Andrés","Cristian","Víctor","Óscar","Iván","Alejandro","Ramón",
  "María","Lucía","Sofía","Camila","Romina","Liz","Patricia","Carolina","Gabriela","Fátima",
  "Larissa","Belén","Tamara","Rocío","Mariana","Daniela","Verónica","Antonella","Cynthia","Noelia"];
const APELLIDOS = ["González","Benítez","Martínez","Rodríguez","López","Giménez","Ramírez","Fernández",
  "Villalba","Cáceres","Ortiz","Ayala","Romero","Acosta","Duarte","Vera","Rojas","Núñez","Franco",
  "Insfrán","Espínola","Aquino","Britez","Mendoza","Riveros","Sosa","Maciel","Ovelar","Báez","Centurión"];

function planificar() {
  const pesoTotal = CIUDADES.reduce((s, c) => s + c[4], 0);
  let asignado = 0;
  const plan = CIUDADES.map((c) => {
    const n = Math.round((c[4] / pesoTotal) * TOTAL);
    asignado += n;
    return { iso: c[0], ciudad: c[1], lat: c[2], lng: c[3], n };
  });
  // Ajuste fino para clavar exactamente TOTAL: la diferencia va a Asunción.
  plan[0].n += TOTAL - asignado;
  return plan;
}

const PAIS_NOMBRE = require("../data/paises").paisNombre;
function resumenPorPais(plan) {
  const m = {};
  for (const p of plan) m[p.iso] = (m[p.iso] || 0) + p.n;
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function imprimirPlan(plan) {
  const total = plan.reduce((s, p) => s + p.n, 0);
  console.log(`\n=== PLAN DE SIEMBRA (${total.toLocaleString("es-PY")} Olimpistas de prueba) ===`);
  console.log(`Ciudades (banderas en el globo): ${plan.length}\n`);
  console.log("Por país:");
  for (const [iso, n] of resumenPorPais(plan)) {
    const pct = ((n / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${iso}  ${String(n).padStart(7)}  ${pct}%  ${PAIS_NOMBRE(iso)}`);
  }
  console.log("\nTop 12 ciudades:");
  plan.slice().sort((a, b) => b.n - a.n).slice(0, 12).forEach((p) =>
    console.log(`  ${String(p.n).padStart(7)}  ${p.ciudad}, ${p.iso}`));
}

function* generarFilas(plan) {
  const HASH = "$2b$10$seedSEEDseedSEEDseedSEuJ8c9Qm0wTq3aXk1pYqZr5sT2vW6yC"; // dummy (nunca inician sesión)
  let i = 0;
  for (const p of plan) {
    for (let k = 0; k < p.n; k++) {
      const nombre = `${NOMBRES[(i * 7 + k) % NOMBRES.length]} ${APELLIDOS[(i * 13 + k * 3) % APELLIDOS.length]}`;
      // jitter mínimo (±0.02°) para que las filas no sean idénticas; el AVG sigue cayendo en la ciudad.
      const jl = ((i * 2654435761) % 1000) / 1000 - 0.5;
      const jg = ((i * 40503) % 1000) / 1000 - 0.5;
      yield {
        id: "seed_" + crypto.randomBytes(7).toString("hex"),
        email: `seed.${i}@${SEED_DOMAIN}`,
        password_hash: HASH,
        nombre,
        pais: PAIS_NOMBRE(p.iso),
        pais_iso: p.iso,
        ciudad: p.ciudad,
        lat: +(p.lat + jl * 0.04).toFixed(5),
        lng: +(p.lng + jg * 0.04).toFixed(5),
      };
      i++;
    }
  }
}

async function conectar() {
  const url = (process.env.OLIMPISTAS_DATABASE_URL || "").trim();
  if (!/^postgres(ql)?:\/\//.test(url)) {
    console.error("\n✖ Falta OLIMPISTAS_DATABASE_URL (o no es una URL postgres). No inserto nada.");
    process.exit(1);
  }
  const postgres = require("postgres");
  return postgres(url, { max: 5, idle_timeout: 20, prepare: false, ssl: "require" });
}

async function borrarSeeds(sql) {
  const r = await sql`DELETE FROM socios WHERE email LIKE ${"%@" + SEED_DOMAIN}`;
  console.log(`Borradas ${r.count} filas de prueba previas.`);
}

async function insertar(plan) {
  const sql = await conectar();
  try {
    await borrarSeeds(sql);
    const filas = [];
    for (const f of generarFilas(plan)) filas.push(f);
    const COLS = ["id", "email", "password_hash", "nombre", "pais", "pais_iso", "ciudad", "lat", "lng"];
    const LOTE = 1000;
    let hechas = 0;
    for (let i = 0; i < filas.length; i += LOTE) {
      const chunk = filas.slice(i, i + LOTE);
      await sql`INSERT INTO socios ${sql(chunk, ...COLS)}`;
      hechas += chunk.length;
      if (hechas % 10000 === 0 || hechas === filas.length)
        console.log(`  insertadas ${hechas.toLocaleString("es-PY")} / ${filas.length.toLocaleString("es-PY")}`);
    }
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM socios WHERE email LIKE ${"%@" + SEED_DOMAIN}`;
    console.log(`\n✔ Listo. Olimpistas de prueba en la base: ${n.toLocaleString("es-PY")}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes("--reset")) {
    const sql = await conectar();
    try { await borrarSeeds(sql); console.log("✔ Reset hecho."); }
    finally { await sql.end({ timeout: 5 }); }
    return;
  }
  const plan = planificar();
  imprimirPlan(plan);
  if (args.includes("--apply")) {
    console.log("\n→ Insertando en la base…");
    await insertar(plan);
  } else {
    console.log("\n(DRY-RUN) No se tocó la base. Agregá --apply para insertar.");
    console.log("Limpieza futura:  node setup/seed-demo.js --reset");
  }
})().catch((e) => { console.error("✖ Error:", e.message); process.exit(1); });
