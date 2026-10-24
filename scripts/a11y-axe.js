"use strict";
/**
 * scripts/a11y-axe.js — revisión de accesibilidad (axe-core, WCAG 2.1 A/AA) de las vistas clave, con un navegador real.
 *
 *   BASE=http://localhost:3000 node scripts/a11y-axe.js
 *
 * Revisa las páginas públicas y, con una cuenta de prueba creada al vuelo (solo con el almacenamiento en memoria, OLIMPISTAS_PERSIST=0), las vistas del miembro,
 * en celular, en escritorio y en celular con tema oscuro. Imprime un resumen por regla y página y lo agrega al resumen del CI.
 * A11Y_FALLA_EN=critical|serious|moderate|minor|ninguno (por defecto "serious"): cantidad de violaciones de ese nivel o peor que hace fallar la corrida.
 * Necesita `playwright` y `@axe-core/playwright` (el flujo de CI los instala; no son dependencias del proyecto).
 */
const fs = require("fs");
const { chromium } = require("playwright");
const { AxeBuilder } = require("@axe-core/playwright");

const BASE = (process.env.BASE || "http://localhost:3000").replace(/\/$/, "");
const NIVELES = ["minor", "moderate", "serious", "critical"];
const FALLA_EN = process.env.A11Y_FALLA_EN || "serious";   // la línea base de hoy es cero violaciones: cualquier problema serio o crítico nuevo falla
const PUBLICAS = ["/", "/en", "/ayuda", "/legal"];
const DEL_MIEMBRO = ["/miembro", "/miembro/carnet", "/miembro/beneficios", "/miembro/historia"];
const VISTAS = [
  { nombre: "celular", width: 390, height: 844, colorScheme: "light" },
  { nombre: "escritorio", width: 1280, height: 800, colorScheme: "light" },
  { nombre: "celular-oscuro", width: 390, height: 844, colorScheme: "dark" },
];

async function cuentaDePrueba() {
  const email = `a11y-${Date.now()}@ejemplo.com`;
  const r = await fetch(BASE + "/api/auth/registro", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "clave-larga-123", nombre: "Revision" }) });
  if (!r.ok) return null;
  const j = await r.json();
  return j.token || null;
}

(async () => {
  const browser = await chromium.launch();
  const token = await cuentaDePrueba();
  const filas = [], porRegla = new Map();
  for (const v of VISTAS) {
    const publicCtx = await browser.newContext({ viewport: { width: v.width, height: v.height }, locale: "es-PY", colorScheme: v.colorScheme });
    const miembroCtx = await browser.newContext({ viewport: { width: v.width, height: v.height }, locale: "es-PY", colorScheme: v.colorScheme });
    if (token) await miembroCtx.addCookies([{ name: "olimpista_sess", value: token, url: BASE }]);
    const paginas = [...PUBLICAS.map((p) => ({ p, ctx: publicCtx })), ...(token ? DEL_MIEMBRO.map((p) => ({ p, ctx: miembroCtx })) : [])];
    for (const { p, ctx } of paginas) {
      const page = await ctx.newPage();
      try {
        await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForTimeout(800);
        const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        for (const x of res.violations) {
          filas.push({ vista: v.nombre, pagina: p, regla: x.id, impacto: x.impact || "minor", nodos: x.nodes.length, ayuda: x.help });
          const k = x.id; const e = porRegla.get(k) || { impacto: x.impact || "minor", ayuda: x.help, nodos: 0, paginas: new Set() };
          e.nodos += x.nodes.length; e.paginas.add(v.nombre + " " + p); porRegla.set(k, e);
        }
        console.log(`${v.nombre.padEnd(10)} ${p.padEnd(22)} ${res.violations.length} reglas con problemas`);
      } catch (e) { console.log(`${v.nombre.padEnd(10)} ${p.padEnd(22)} NO SE PUDO REVISAR: ${e.message.split("\n")[0]}`); filas.push({ vista: v.nombre, pagina: p, regla: "no-se-pudo-revisar", impacto: "minor", nodos: 0, ayuda: e.message.split("\n")[0] }); }
      finally { await page.close(); }
    }
    await publicCtx.close(); await miembroCtx.close();
  }
  await browser.close();

  const orden = [...porRegla.entries()].sort((a, b) => NIVELES.indexOf(b[1].impacto) - NIVELES.indexOf(a[1].impacto) || b[1].nodos - a[1].nodos);
  const md = ["## Accesibilidad (axe, WCAG 2.1 AA)", "", orden.length ? "| Impacto | Regla | Elementos | Dónde | Qué pasa |\n|---|---|---|---|---|" : "Sin violaciones.",
    ...orden.map(([id, e]) => `| ${e.impacto} | \`${id}\` | ${e.nodos} | ${[...e.paginas].slice(0, 4).join(", ")}${e.paginas.size > 4 ? ` (+${e.paginas.size - 4})` : ""} | ${e.ayuda} |`)].join("\n");
  console.log("\n" + md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  const umbral = NIVELES.indexOf(FALLA_EN);
  const graves = umbral < 0 ? 0 : filas.filter((f) => NIVELES.indexOf(f.impacto) >= umbral).length;
  if (graves) { console.error(`\n${graves} violaciones de nivel ${FALLA_EN} o peor.`); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(2); });
