"use strict";
/**
 * seed-demo.js — Carga ~150.000 Olimpistas DE PRUEBA con distribución mundial
 * realista para Club Olimpia.
 *
 * Modelo de distribución (2 niveles):
 *   1) CUOTA POR PAÍS (PAIS_SHARE): qué porcentaje del total va a cada país.
 *      Paraguay domina (~65%); el resto es diáspora + cola global.
 *   2) PESO POR CIUDAD dentro de cada país: reparte la cuota del país entre sus
 *      ciudades de forma proporcional al peso (ciudades reales, por población).
 *
 * Los datos alimentan el contador global y el globo (una bandera por ciudad).
 *
 * Uso:
 *   node setup/seed-demo.js                 → DRY-RUN: imprime el plan, no toca la DB
 *   OLIMPISTAS_DATABASE_URL=... node setup/seed-demo.js --apply   → inserta (reemplaza)
 *   node setup/seed-demo.js --reset         → borra SOLO las filas de prueba
 *
 * Marca: todas las filas usan email "...@demo.olimpistas.test".
 */
const crypto = require("crypto");

const TOTAL = Number(process.env.SEED_TOTAL || 150000);
const SEED_DOMAIN = "demo.olimpistas.test";

// Banderas "en tu casa" de demo (opt-in, punto exacto a nivel domicilio). Se reparten
// en barrios reales con jitter chico (~400m) para que al hacer zoom se vean casas
// sueltas con bandera. Forman parte del TOTAL (se restan del agregado por ciudad).
const CASAS_TOTAL = Number(process.env.SEED_CASAS || 1800);
const BARRIOS = [
  // [iso, ciudad, barrio, lat, lng, peso]
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

// ── 1) Cuota por país (se NORMALIZA, no hace falta que sume 1) ───────────────
//    Paraguay ~65%; diáspora paraguaya histórica: Argentina, Brasil (frontera),
//    España, USA; después una cola global con presencia simbólica.
const PAIS_SHARE = {
  PY: 73,                       // núcleo (~65% del total tras normalizar la cola global)
  AR: 11.5, BR: 6, ES: 5, US: 4.2,   // diáspora fuerte
  IT: 1.3, BO: 1.2, MX: 0.8, DE: 0.8, UY: 0.8, CL: 0.7, FR: 0.7,
  PE: 0.6, GB: 0.6, CO: 0.6, CA: 0.5, PT: 0.4, AU: 0.4, EC: 0.35, VE: 0.35,
  PA: 0.3, CH: 0.3, CR: 0.25, DO: 0.25, NL: 0.25, JP: 0.25, BE: 0.2, AE: 0.2,
  SE: 0.15, IL: 0.15, ZA: 0.12, CN: 0.12, NZ: 0.1, KR: 0.1,
};

// ── 2) Ciudades por país, con peso relativo (≈ por población/hinchada) ───────
//    [iso, ciudad, lat, lng, pesoCiudad]
const CIUDADES = [
  // ════ PARAGUAY — los 17 departamentos + capital ════
  // Central (Gran Asunción) — la mayor concentración del país
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
  // Alto Paraná
  ["PY", "Ciudad del Este", -25.5097, -54.6111, 46],
  ["PY", "Presidente Franco", -25.5500, -54.6100, 13],
  ["PY", "Hernandarias", -25.4050, -54.6400, 11],
  ["PY", "Minga Guazú", -25.4900, -54.8200, 9],
  ["PY", "Santa Rita", -25.8000, -55.0500, 5],
  // Itapúa
  ["PY", "Encarnación", -27.3306, -55.8667, 22],
  ["PY", "Cambyretá", -27.3000, -55.8200, 5],
  ["PY", "Hohenau", -27.0833, -55.7500, 3],
  ["PY", "Coronel Bogado", -27.1700, -56.2500, 3],
  // Caaguazú
  ["PY", "Coronel Oviedo", -25.4500, -56.4400, 12],
  ["PY", "Caaguazú", -25.4636, -56.0156, 10],
  ["PY", "Campo 9", -25.3500, -55.7500, 5],
  // San Pedro
  ["PY", "Santaní", -24.6500, -56.4400, 6],
  ["PY", "San Pedro de Ycuamandyyú", -24.0900, -57.0800, 4],
  // Cordillera
  ["PY", "Caacupé", -25.3858, -57.1419, 8],
  ["PY", "Tobatí", -25.2500, -57.0800, 4],
  ["PY", "Eusebio Ayala", -25.3800, -56.9300, 3],
  ["PY", "Piribebuy", -25.4700, -57.0000, 3],
  // Guairá
  ["PY", "Villarrica", -25.7833, -56.4333, 9],
  // Paraguarí
  ["PY", "Paraguarí", -25.6219, -57.1453, 5],
  ["PY", "Carapeguá", -25.7900, -57.2400, 4],
  ["PY", "Ybycuí", -26.0167, -56.9333, 2],
  // Concepción
  ["PY", "Concepción", -23.4064, -57.4344, 9],
  // Amambay
  ["PY", "Pedro Juan Caballero", -22.5470, -55.7330, 14],
  // Canindeyú
  ["PY", "Salto del Guairá", -24.0600, -54.3100, 4],
  ["PY", "Curuguaty", -24.5167, -55.6900, 4],
  // Caazapá
  ["PY", "Caazapá", -26.1972, -56.3711, 3],
  // Misiones
  ["PY", "San Juan Bautista", -26.6678, -57.1469, 4],
  ["PY", "Santa Rosa", -26.8700, -56.8500, 2],
  // Ñeembucú
  ["PY", "Pilar", -26.8597, -58.2992, 5],
  // Presidente Hayes (Chaco)
  ["PY", "Villa Hayes", -25.0900, -57.5240, 4],
  ["PY", "Benjamín Aceval", -24.9667, -57.5667, 2],
  // Boquerón (Chaco central — colonias menonitas)
  ["PY", "Filadelfia", -22.3500, -60.0300, 4],
  ["PY", "Loma Plata", -22.3800, -59.8400, 3],
  ["PY", "Mariscal Estigarribia", -22.0300, -60.6100, 2],
  // Alto Paraguay
  ["PY", "Fuerte Olimpo", -21.0419, -57.8739, 1],

  // ════ ARGENTINA — Buenos Aires + frontera (gran colectividad paraguaya) ════
  ["AR", "Buenos Aires", -34.6037, -58.3816, 100],
  ["AR", "Formosa", -26.1775, -58.1781, 30],
  ["AR", "Clorinda", -25.2853, -57.7197, 24],
  ["AR", "Córdoba", -31.4201, -64.1888, 28],
  ["AR", "Rosario", -32.9442, -60.6505, 24],
  ["AR", "Posadas", -27.3671, -55.8961, 22],
  ["AR", "Resistencia", -27.4514, -58.9867, 16],
  ["AR", "La Plata", -34.9215, -57.9545, 12],
  ["AR", "Mendoza", -32.8895, -68.8458, 9],
  // ════ BRASIL — frontera + metrópolis ════
  ["BR", "São Paulo", -23.5505, -46.6333, 40],
  ["BR", "Foz do Iguaçu", -25.5163, -54.5854, 38],
  ["BR", "Ponta Porã", -22.5296, -55.7203, 28],
  ["BR", "Curitiba", -25.4284, -49.2733, 16],
  ["BR", "Rio de Janeiro", -22.9068, -43.1729, 13],
  ["BR", "Brasília", -15.7939, -47.8828, 10],
  // ════ ESPAÑA ════
  ["ES", "Madrid", 40.4168, -3.7038, 100],
  ["ES", "Barcelona", 41.3851, 2.1734, 75],
  ["ES", "Valencia", 39.4699, -0.3763, 28],
  ["ES", "Málaga", 36.7213, -4.4214, 20],
  ["ES", "Bilbao", 43.2630, -2.9350, 15],
  // ════ ESTADOS UNIDOS ════
  ["US", "Miami", 25.7617, -80.1918, 100],
  ["US", "New York", 40.7128, -74.0060, 65],
  ["US", "Los Angeles", 34.0522, -118.2437, 44],
  ["US", "Houston", 29.7604, -95.3698, 30],
  ["US", "Chicago", 41.8781, -87.6298, 25],
  ["US", "Washington DC", 38.9072, -77.0369, 22],
  // ════ Resto de América Latina ════
  ["UY", "Montevideo", -34.9011, -56.1645, 100],
  ["UY", "Salto", -31.3833, -57.9667, 18],
  ["BO", "Santa Cruz de la Sierra", -17.7833, -63.1821, 100],
  ["BO", "La Paz", -16.5000, -68.1500, 45],
  ["BO", "Cochabamba", -17.3895, -66.1568, 25],
  ["CL", "Santiago", -33.4489, -70.6693, 100],
  ["CL", "Antofagasta", -23.6509, -70.3975, 18],
  ["PE", "Lima", -12.0464, -77.0428, 100],
  ["CO", "Bogotá", 4.7110, -74.0721, 100],
  ["CO", "Medellín", 6.2442, -75.5812, 35],
  ["EC", "Quito", -0.1807, -78.4678, 100],
  ["EC", "Guayaquil", -2.1894, -79.8891, 60],
  ["VE", "Caracas", 10.4806, -66.9036, 100],
  ["MX", "Ciudad de México", 19.4326, -99.1332, 100],
  ["MX", "Guadalajara", 20.6597, -103.3496, 30],
  ["CR", "San José", 9.9281, -84.0907, 100],
  ["PA", "Ciudad de Panamá", 8.9824, -79.5199, 100],
  ["DO", "Santo Domingo", 18.4861, -69.9312, 100],
  // ════ Europa ════
  ["IT", "Milán", 45.4642, 9.1900, 100],
  ["IT", "Roma", 41.9028, 12.4964, 78],
  ["IT", "Turín", 45.0703, 7.6869, 30],
  ["FR", "París", 48.8566, 2.3522, 100],
  ["FR", "Lyon", 45.7640, 4.8357, 28],
  ["DE", "Berlín", 52.5200, 13.4050, 100],
  ["DE", "Frankfurt", 50.1109, 8.6821, 60],
  ["DE", "Múnich", 48.1351, 11.5820, 45],
  ["GB", "Londres", 51.5074, -0.1278, 100],
  ["GB", "Manchester", 53.4808, -2.2426, 25],
  ["PT", "Lisboa", 38.7223, -9.1393, 100],
  ["PT", "Oporto", 41.1579, -8.6291, 35],
  ["CH", "Zúrich", 47.3769, 8.5417, 100],
  ["CH", "Ginebra", 46.2044, 6.1432, 55],
  ["NL", "Ámsterdam", 52.3676, 4.9041, 100],
  ["BE", "Bruselas", 50.8503, 4.3517, 100],
  ["SE", "Estocolmo", 59.3293, 18.0686, 100],
  // ════ Resto del mundo (presencia simbólica) ════
  ["CA", "Toronto", 43.6532, -79.3832, 100],
  ["CA", "Montreal", 45.5017, -73.5673, 45],
  ["AU", "Sídney", -33.8688, 151.2093, 100],
  ["AU", "Melbourne", -37.8136, 144.9631, 55],
  ["JP", "Tokio", 35.6762, 139.6503, 100],
  ["AE", "Dubái", 25.2048, 55.2708, 100],
  ["IL", "Tel Aviv", 32.0853, 34.7818, 100],
  ["ZA", "Johannesburgo", -26.2041, 28.0473, 100],
  ["NZ", "Auckland", -36.8485, 174.7633, 100],
  ["CN", "Shanghái", 31.2304, 121.4737, 100],
  ["KR", "Seúl", 37.5665, 126.9780, 100],
];

const NOMBRES = ["Juan","José","Carlos","Luis","Miguel","Diego","Sergio","Marcos","Fernando","Rodrigo",
  "Gustavo","Hugo","Pablo","Andrés","Cristian","Víctor","Óscar","Iván","Alejandro","Ramón",
  "María","Lucía","Sofía","Camila","Romina","Liz","Patricia","Carolina","Gabriela","Fátima",
  "Larissa","Belén","Tamara","Rocío","Mariana","Daniela","Verónica","Antonella","Cynthia","Noelia"];
const APELLIDOS = ["González","Benítez","Martínez","Rodríguez","López","Giménez","Ramírez","Fernández",
  "Villalba","Cáceres","Ortiz","Ayala","Romero","Acosta","Duarte","Vera","Rojas","Núñez","Franco",
  "Insfrán","Espínola","Aquino","Britez","Mendoza","Riveros","Sosa","Maciel","Ovelar","Báez","Centurión"];

const PAIS_NOMBRE = require("../data/paises").paisNombre;

function planificar() {
  // Agrupar ciudades por país y normalizar las cuotas.
  const porPaisCiudades = {};
  for (const c of CIUDADES) (porPaisCiudades[c[0]] = porPaisCiudades[c[0]] || []).push(c);
  const shareSum = Object.values(PAIS_SHARE).reduce((s, v) => s + v, 0);

  const plan = [];
  let asignado = 0;
  for (const [iso, share] of Object.entries(PAIS_SHARE)) {
    const ciudades = porPaisCiudades[iso];
    if (!ciudades) continue;
    const cuotaPais = Math.round((share / shareSum) * (TOTAL - CASAS_TOTAL));   // agregado por ciudad
    const pesoSum = ciudades.reduce((s, c) => s + c[4], 0);
    let asignadoPais = 0;
    const filasPais = ciudades.map((c) => {
      const n = Math.round((c[4] / pesoSum) * cuotaPais);
      asignadoPais += n;
      return { iso, ciudad: c[1], lat: c[2], lng: c[3], n };
    });
    // Ajuste del redondeo del país → a su ciudad principal.
    filasPais[0].n += cuotaPais - asignadoPais;
    asignado += cuotaPais;
    plan.push(...filasPais);
  }
  // Ajuste global final → a Asunción (primera fila del plan).
  plan[0].n += (TOTAL - CASAS_TOTAL) - asignado;
  return plan;
}

// Plan de casas (opt-in, punto exacto). Reparte CASAS_TOTAL por peso de barrio.
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

function resumenPorPais(plan) {
  const m = {};
  for (const p of plan) m[p.iso] = (m[p.iso] || 0) + p.n;
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function imprimirPlan(plan) {
  const totalCiudades = plan.reduce((s, p) => s + p.n, 0);
  const total = totalCiudades + CASAS_TOTAL;
  console.log(`\n=== PLAN DE SIEMBRA (${total.toLocaleString("es-PY")} Olimpistas: ${totalCiudades.toLocaleString("es-PY")} por ciudad + ${CASAS_TOTAL.toLocaleString("es-PY")} casas) ===`);
  console.log(`Países: ${new Set(plan.map((p) => p.iso)).size}  ·  Ciudades (banderas): ${plan.length}\n`);
  console.log("Por país:");
  for (const [iso, n] of resumenPorPais(plan)) {
    const pct = ((n / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${iso}  ${String(n).padStart(7)}  ${pct}%  ${PAIS_NOMBRE(iso)}`);
  }
  const py = plan.filter((p) => p.iso === "PY");
  console.log(`\nParaguay: ${py.length} ciudades, ${py.reduce((s,p)=>s+p.n,0).toLocaleString("es-PY")} Olimpistas. Top 10:`);
  py.slice().sort((a, b) => b.n - a.n).slice(0, 10).forEach((p) =>
    console.log(`  ${String(p.n).padStart(7)}  ${p.ciudad}`));
  const pc = planificarCasas();
  console.log(`\n🚩 Banderas "en tu casa" (opt-in, punto exacto): ${pc.reduce((s,b)=>s+b.n,0).toLocaleString("es-PY")} en ${pc.length} barrios:`);
  pc.slice().sort((a, b) => b.n - a.n).slice(0, 6).forEach((b) =>
    console.log(`  ${String(b.n).padStart(5)}  ${b.barrio}, ${b.ciudad}`));
}

function* generarFilas(plan) {
  const HASH = "$2b$10$seedSEEDseedSEEDseedSEuJ8c9Qm0wTq3aXk1pYqZr5sT2vW6yC"; // dummy (nunca inician sesión)
  let i = 0;
  for (const p of plan) {
    for (let k = 0; k < p.n; k++) {
      const nombre = `${NOMBRES[(i * 7 + k) % NOMBRES.length]} ${APELLIDOS[(i * 13 + k * 3) % APELLIDOS.length]}`;
      const jl = ((i * 2654435761) % 1000) / 1000 - 0.5;   // jitter mínimo (±0.02°)
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
        mostrar_exacto: false,
      };
      i++;
    }
  }
}

// Casas opt-in: punto exacto (jitter ~400m dentro del barrio), mostrar_exacto = true.
function* generarCasas(planCasas) {
  const HASH = "$2b$10$seedSEEDseedSEEDseedSEuJ8c9Qm0wTq3aXk1pYqZr5sT2vW6yC";
  let i = 0;
  for (const b of planCasas) {
    for (let k = 0; k < b.n; k++) {
      const nombre = `${NOMBRES[(i * 11 + k) % NOMBRES.length]} ${APELLIDOS[(i * 5 + k * 7) % APELLIDOS.length]}`;
      const jl = ((i * 2654435761 + k * 97) % 1000) / 1000 - 0.5;
      const jg = ((i * 40503 + k * 31) % 1000) / 1000 - 0.5;
      yield {
        id: "seed_" + crypto.randomBytes(7).toString("hex"),
        email: `casa.${i}@${SEED_DOMAIN}`,
        password_hash: HASH,
        nombre,
        pais: PAIS_NOMBRE(b.iso),
        pais_iso: b.iso,
        ciudad: b.ciudad,
        lat: +(b.lat + jl * 0.008).toFixed(6),   // ~±450m
        lng: +(b.lng + jg * 0.008).toFixed(6),
        mostrar_exacto: true,
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
    for (const f of generarCasas(planificarCasas())) filas.push(f);
    const COLS = ["id", "email", "password_hash", "nombre", "pais", "pais_iso", "ciudad", "lat", "lng", "mostrar_exacto"];
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
