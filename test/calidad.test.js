"use strict";
// Control de calidad barato y sin dependencias: todo el JavaScript (servidor, scripts del navegador y <script> en línea de las
// páginas) tiene que compilar, y no se cuelan marcas de depuración. Un error de sintaxis en un <script> de admin.html
// dejaría el panel en blanco y ningún otro test lo notaría.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RAIZ = path.join(__dirname, "..");
const lista = (dir, ext) => fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true })
  .flatMap((d) => d.isDirectory() ? (["node_modules", "assets", "vendor"].includes(d.name) ? [] : lista(path.join(dir, d.name), ext)) : d.name.endsWith(ext) ? [path.join(dir, d.name)] : []);
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), "utf8");

test("el JavaScript del servidor compila (server, routes, config, lib, data, setup)", () => {
  const archivos = ["server.js", "routes.js", "config.js", ...lista("lib", ".js"), ...lista("data", ".js"), ...(fs.existsSync(path.join(RAIZ, "setup")) ? lista("setup", ".js") : [])];
  for (const f of archivos) {
    const src = leer(f).replace(/^#!.*/, "");
    assert.doesNotThrow(() => new vm.Script("(function(exports, require, module, __filename, __dirname){" + src + "\n})", { filename: f }), f);
  }
});

test("el JavaScript del navegador compila (public/js)", () => {
  for (const f of lista("public/js", ".js")) {
    if (f.endsWith(".min.js") || /vendor|\.umd\./.test(f)) continue;
    assert.doesNotThrow(() => new vm.Script(leer(f), { filename: f }), f);
  }
});

test("los <script> en línea de cada página compilan", () => {
  let vistos = 0;
  for (const f of lista("public", ".html")) {
    const html = leer(f);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attrs = m[1], cuerpo = m[2];
      if (/\bsrc=/.test(attrs) || !cuerpo.trim()) continue;
      if (/type=["']?(application\/(ld\+)?json|importmap|text\/template)/i.test(attrs)) { assert.doesNotThrow(() => JSON.parse(cuerpo), f + " (json)"); continue; }
      vistos++;
      assert.doesNotThrow(() => new vm.Script(cuerpo, { filename: f }), f);
    }
  }
  assert.ok(vistos >= 3, "se revisaron los scripts en línea (admin, comercio, peña…)");
});

test("no quedan debugger ni console.log sueltos en el código del navegador", () => {
  for (const f of lista("public/js", ".js")) {
    const src = leer(f);
    assert.ok(!/\bdebugger\b/.test(src), "debugger en " + f);
    assert.ok(!/^\s*console\.log\(/m.test(src), "console.log en " + f);
  }
});

test(".env.example documenta cada variable de entorno que lee el código (salvo las internas)", () => {
  const usadas = new Set();
  for (const f of ["server.js", "routes.js", "config.js", ...lista("lib", ".js"), ...lista("data", ".js")])
    for (const m of leer(f).matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) usadas.add(m[1]);
  const interna = new Set(["NODE_ENV", "PORT", "K_REVISION", "K_SERVICE", "TEST_LIMITES", "TEST_DATABASE_URL", "PAGOPAR_TEST_KEY"]);
  const ejemplo = leer(".env.example");
  const faltan = [...usadas].filter((v) => !interna.has(v) && !new RegExp("^#? *" + v + "=", "m").test(ejemplo)).sort();
  assert.deepStrictEqual(faltan, [], "faltan en .env.example: " + faltan.join(", "));
});
