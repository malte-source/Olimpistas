"use strict";
// Interfaz nativa (handoff v2): un solo sistema visual. Guardas baratas para que no se cuelen de vuelta
// los colores viejos, los emojis, los diálogos nativos, las fuentes duplicadas ni íconos que no existen en el sprite.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const PUBLIC = path.join(__dirname, "..", "public");
const leer = (rel) => fs.readFileSync(path.join(PUBLIC, rel), "utf8");
const archivos = (dir, ext) => fs.readdirSync(path.join(PUBLIC, dir)).filter((f) => ext.some((e) => f.endsWith(e))).map((f) => path.join(dir, f));
const TEXTO = [...archivos(".", [".html"]), ...archivos("js", [".js"]), ...archivos("css", [".css"]), "manifest.webmanifest"];
const PAGINAS = ["admin.html", "comercio.html", "pena.html", "ayuda.html", "reset.html", "socio.html", "index.html", "legal.html"];

test("colores de la paleta vieja: ninguno queda en public/", () => {
  const malos = /#0b0b0f|#0a0a0e|#c9a227|#e7c64b|#f0d873|#f3efe4|#14141b|#14141c/i;
  const hallados = TEXTO.filter((f) => malos.test(leer(f)));
  assert.deepStrictEqual(hallados, []);
});

test("todas las páginas cargan tema.js (claro/oscuro/automático sin destello) y declaran el color de la barra de estado", () => {
  for (const p of PAGINAS) {
    const h = leer(p);
    assert.ok(/\/js\/tema\.js/.test(h), p + " no carga tema.js");
    assert.ok(/name="theme-color"[^>]*#0a0a0a/.test(h), p + " sin theme-color #0a0a0a");
  }
});

test("sin emojis en la interfaz de las páginas del club, el comercio, la peña, la ayuda y el reset", () => {
  const emoji = /\p{Extended_Pictographic}/u;
  for (const p of ["admin.html", "comercio.html", "pena.html", "ayuda.html", "reset.html", "socio.html"]) {
    const m = leer(p).match(emoji);
    assert.ok(!m, `${p} tiene un emoji: ${m && m[0]}`);
  }
});

test("sin alert()/confirm()/prompt() del navegador en las páginas ni en los scripts propios", () => {
  const nativo = /(^|[^.\w$])(alert|confirm|prompt)\s*\(/;
  for (const f of TEXTO.filter((x) => /\.(html|js)$/.test(x) && !/vendor|globe/.test(x))) {
    const quitaComentarios = leer(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(!nativo.test(quitaComentarios.replace(/async function confirmar|function confirmar|confirmar\(/g, "")), `${f} usa un diálogo nativo`);
  }
});

test("fuentes: solo Saira (Archivo e Inter eran el mismo archivo repetido y no se usaban)", () => {
  const dir = fs.readdirSync(path.join(PUBLIC, "assets", "fonts"));
  assert.deepStrictEqual(dir.filter((f) => /^(archivo|inter)-/.test(f)), []);
  const css = leer("assets/fonts/fonts.css");
  assert.ok(!/Archivo|Inter\b/.test(css.replace(/Saira Condensed/g, "")));
  assert.ok(/--font-ui:\s*-apple-system/.test(leer("css/styles.css")), "texto corrido en la fuente del sistema");
});

test("íconos: todo id del sprite que se usa existe (y la pestaña activa tiene su variante rellena)", () => {
  const sprite = leer("assets/icons.svg");
  const ids = new Set([...sprite.matchAll(/<symbol id="i-([^"]+)"/g)].map((m) => m[1]));
  const usados = new Set();
  for (const f of TEXTO.filter((x) => /\.(html|js)$/.test(x))) {
    const t = leer(f);
    for (const m of t.matchAll(/icons\.svg#i-([a-z0-9-]+)/g)) usados.add(m[1]);
    for (const m of t.matchAll(/\b(?:OLI\.ic|ic|sp)\(\s*"([a-z0-9-]+)"(?:\s*,\s*[\w.]+)?(?:\s*,\s*(true))?/g)) usados.add(m[1] + (m[2] ? "-f" : ""));
  }
  const faltan = [...usados].filter((id) => !ids.has(id));
  assert.deepStrictEqual(faltan, [], "íconos usados que no están en public/assets/icons.svg");
  for (const tab of ["inicio", "partidos", "carnet", "beneficios", "puntos"]) assert.ok(ids.has(tab) && ids.has(tab + "-f"), "pestaña sin variante rellena: " + tab);
});

test("manifest: abre en la app del hincha, con atajos y colores de marca", () => {
  const m = JSON.parse(leer("manifest.webmanifest"));
  assert.strictEqual(m.start_url, "/miembro");
  assert.strictEqual(m.theme_color, "#0a0a0a");
  assert.strictEqual(m.background_color, "#0a0a0a");
  assert.deepStrictEqual(m.shortcuts.map((s) => s.url), ["/miembro/carnet", "/miembro/partidos", "/miembro/descubrir/subastas"]);
});

test("el CSS no tiene tamaños de letra sueltos: todo sale de la escala (salvo inputs de 16 px y el hero)", () => {
  const css = leer("css/styles.css");
  const sueltos = [...css.matchAll(/(?<![-\w])font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1])).filter((n) => ![16, 68, 72, 84, 96].includes(n));
  assert.deepStrictEqual(sueltos, [], "font-size en px fuera de los tokens --t-*");
  let balance = 0; for (const c of css) { if (c === "{") balance++; if (c === "}") balance--; }
  assert.strictEqual(balance, 0, "llaves balanceadas");
});
