"use strict";
// Tablas del panel: las peñas usan la tabla común (filtro, orden, paginación, exportar) y los encabezados ordenables son botones accesibles.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const a = fs.readFileSync(path.join(__dirname, "..", "public", "admin.html"), "utf8");

test("peñas: tabla común con filtro y orden, exportar CSV, y las acciones por fila siguen con sus permisos", () => {
  assert.ok(/id="penasTabla"/.test(a) && /id="penasCsv"/.test(a));
  assert.ok(/tabla\(\$\("penasTabla"\), colsP, ok, [\s\S]{0,200}filtro: true/.test(a), "usa la tabla común con filtro");
  for (const k of ['data-penaed="', 'data-penapad="', 'data-penaacc="', 'data-penaest="']) assert.ok(a.includes(k), k + " se conserva");
  assert.ok(/\(w \? '<button class="btn btn-sm btn-ghost" data-penaed=/.test(a), "Datos solo con permiso de escritura");
  assert.ok(/d\.owner \? \['padron_al_dia', 'padron_en_mora'\]|d\.owner \? \["padron_al_dia", "padron_en_mora"\]/.test(a), "el CSV incluye mora solo para el owner");
  assert.ok(/download = "penas\.csv"/.test(a));
  assert.ok(/\^\[=\+\\-@\\t\\r\]/.test(a), "el CSV neutraliza fórmulas");
});

test("encabezados ordenables: botón con aria-sort en el th (teclado y lectores de pantalla)", () => {
  assert.ok(/<th scope="col"' \+ \(ord \? ' aria-sort="'/.test(a));
  assert.ok(/<button type="button" class="soc-th" data-sort="'/.test(a));
});
