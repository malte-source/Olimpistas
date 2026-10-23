"use strict";
// Prueba de carga liviana y sin dependencias, para STAGING (nunca producción: crea socios de prueba).
//
//   node setup/carga.js https://olimpistas-staging-....run.app --escenario lectura --concurrencia 40 --segundos 30
//   node setup/carga.js <url> --escenario registro --concurrencia 10 --segundos 30      (bcrypt: cuesta CPU de verdad)
//   node setup/carga.js <url> --escenario sesion --concurrencia 40 --segundos 30        (usuarios ya logueados)
//
// Escenarios:
//   lectura   visitantes anónimos: inicio, config, stats, mapa, listas públicas
//   registro  registros nuevos (emails de prueba @carga.olimpistas.test) + primera pantalla de socio
//   sesion    N socios ya registrados navegando: yo, beneficios, subastas, sorteos, carnet
//
// Imprime por ruta: pedidos, errores, p50/p95/p99 y estado HTTP. No guarda nada fuera de la memoria.

const args = process.argv.slice(2);
const url = (args[0] || "").replace(/\/+$/, "");
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const escenario = opt("escenario", "lectura");
const concurrencia = Math.max(1, Number(opt("concurrencia", 20)));
const segundos = Math.max(1, Number(opt("segundos", 20)));

if (!/^https?:\/\//.test(url)) { console.error("Uso: node setup/carga.js <url-de-staging> [--escenario lectura|registro|sesion] [--concurrencia N] [--segundos N]"); process.exit(1); }
if (/(^|\.)olimpistas\.com(\/|$|:)/i.test(new URL(url).host + "/")) { console.error("Se niega a correr contra producción (olimpistas.com): crea socios de prueba. Usá staging."); process.exit(1); }

const stats = new Map();
const registrar = (ruta, ms, status, err) => {
  let s = stats.get(ruta); if (!s) stats.set(ruta, s = { ms: [], estados: {}, errores: 0 });
  s.ms.push(ms);
  const k = err ? "red" : String(status); s.estados[k] = (s.estados[k] || 0) + 1;
  if (err || status >= 500) s.errores++;
};
async function pedir(ruta, { metodo = "GET", cuerpo, token, etiqueta } = {}) {
  const t0 = performance.now();
  try {
    const r = await fetch(url + ruta, {
      method: metodo,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const texto = await r.text();
    registrar(etiqueta || (metodo + " " + ruta), performance.now() - t0, r.status);
    let json = null; try { json = JSON.parse(texto); } catch (e) {}
    return { status: r.status, json };
  } catch (e) { registrar(etiqueta || (metodo + " " + ruta), performance.now() - t0, 0, e); return { status: 0, json: null }; }
}
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const corrida = Date.now().toString(36);
let n = 0;
async function nuevoSocio() {
  const r = await pedir("/api/auth/registro", { metodo: "POST", etiqueta: "POST /api/auth/registro", cuerpo: { email: `c${corrida}-${++n}-${Math.random().toString(36).slice(2, 6)}@carga.olimpistas.test`, password: "clave-larga-123", nombre: "Carga", apellido: "Prueba" } });
  return r.json && r.json.token ? r.json.token : null;
}

const ESCENARIOS = {
  async lectura() {
    for (const ruta of ["/", "/api/config", "/api/stats", "/api/sorteos", "/api/preventas", "/api/mapa/celdas?bbox=-58,-26,-57,-25"]) await pedir(ruta, { etiqueta: "GET " + ruta.split("?")[0] });
    await pausa(200 + Math.random() * 400);
  },
  async registro() {
    const token = await nuevoSocio(); if (!token) return pausa(500);
    await pedir("/api/auth/yo", { token, etiqueta: "GET /api/auth/yo" });
    await pedir("/api/beneficios", { token, etiqueta: "GET /api/beneficios" });
  },
  async sesion(ctx) {
    if (!ctx.token) { ctx.token = await nuevoSocio(); if (!ctx.token) return pausa(500); }
    for (const ruta of ["/api/auth/yo", "/api/beneficios", "/api/subastas", "/api/sorteos", "/api/carnet"]) await pedir(ruta, { token: ctx.token, etiqueta: "GET " + ruta });
    await pausa(300 + Math.random() * 700);
  },
};
if (!ESCENARIOS[escenario]) { console.error("Escenario desconocido: " + escenario); process.exit(1); }

const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0;
(async () => {
  console.log(`Carga ${escenario} → ${url} · ${concurrencia} en paralelo · ${segundos} s`);
  const fin = Date.now() + segundos * 1000, t0 = Date.now();
  await Promise.all(Array.from({ length: concurrencia }, async () => { const ctx = {}; while (Date.now() < fin) await ESCENARIOS[escenario](ctx); }));
  const dur = (Date.now() - t0) / 1000;
  let total = 0, errores = 0;
  const filas = [...stats.entries()].sort((a, b) => b[1].ms.length - a[1].ms.length).map(([ruta, s]) => {
    s.ms.sort((a, b) => a - b); total += s.ms.length; errores += s.errores;
    return `${ruta.padEnd(36)} ${String(s.ms.length).padStart(6)} pedidos  p50 ${pct(s.ms, .5).toFixed(0).padStart(5)} ms  p95 ${pct(s.ms, .95).toFixed(0).padStart(5)} ms  p99 ${pct(s.ms, .99).toFixed(0).padStart(5)} ms  errores ${s.errores}  ${JSON.stringify(s.estados)}`;
  });
  console.log("\n" + filas.join("\n"));
  console.log(`\nTotal ${total} pedidos en ${dur.toFixed(1)} s = ${(total / dur).toFixed(1)} pedidos/s · errores (5xx/red): ${errores} (${total ? (100 * errores / total).toFixed(2) : 0}%)`);
})();
