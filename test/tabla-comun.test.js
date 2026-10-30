"use strict";
// Tabla común del panel: filtro, orden, páginas y exportar CSV (lo que se está viendo), en ofertas, premios y en la lista de subastas, sorteos y demás.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const a = fs.readFileSync(path.join(__dirname, "..", "public", "admin.html"), "utf8");

// Se ejecuta el código real de la página (filas visibles y exportación) con un documento de mentira.
function cargar() {
  const ini = a.indexOf("function tablaFilas(st)"), fin = a.indexOf("function renderTablaBody(cont)");
  assert.ok(ini > 0 && fin > ini, "están las funciones de la tabla");
  const bajadas = [];
  class FakeBlob { constructor(partes) { this.texto = partes.join(""); } }
  const documento = { body: { appendChild() {} }, createElement: () => ({ click() { bajadas.push({ href: this.href, nombre: this.download }); }, remove() {} }) };
  const URLfalsa = { createObjectURL: (b) => { bajadas.ultimo = b.texto; return "blob:x"; }, revokeObjectURL() {} };
  const src = a.slice(ini, fin);
  const f = new Function("document", "Blob", "URL", src + "; return { tablaFilas, tablaCsv };")(documento, FakeBlob, URLfalsa);
  return { ...f, bajadas };
}
const cols = [{ key: "n", text: (r) => r.n }, { key: "v", text: (r) => String(r.v).padStart(5, "0") }, { key: "acc", sortable: false }];
const filas = [{ n: "Banana", v: 20 }, { n: "=cmd|' /C calc'!A0", v: 5 }, { n: "Cereza", v: 300 }, { n: "Anís", v: 1 }];

test("filas visibles: se filtra por cualquier columna y se ordena con números en orden natural; las columnas sin texto no se usan", () => {
  const { tablaFilas } = cargar();
  assert.deepStrictEqual(tablaFilas({ cols, rows: filas, filter: "", sortKey: null, sortDir: 1 }).map((r) => r.n), ["Banana", "=cmd|' /C calc'!A0", "Cereza", "Anís"], "sin orden, el original");
  assert.deepStrictEqual(tablaFilas({ cols, rows: filas, filter: "", sortKey: "v", sortDir: 1 }).map((r) => r.v), [1, 5, 20, 300]);
  assert.deepStrictEqual(tablaFilas({ cols, rows: filas, filter: "", sortKey: "v", sortDir: -1 }).map((r) => r.v), [300, 20, 5, 1]);
  assert.deepStrictEqual(tablaFilas({ cols, rows: filas, filter: "ce", sortKey: "n", sortDir: 1 }).map((r) => r.n), ["Cereza"], "el filtro no distingue mayúsculas");
  assert.deepStrictEqual(tablaFilas({ cols, rows: filas, filter: "00020", sortKey: null, sortDir: 1 }).map((r) => r.n), ["Banana"], "filtra también por las otras columnas");
  assert.deepStrictEqual(tablaFilas({ cols, rows: filas, filter: "no existe", sortKey: null, sortDir: 1 }), []);
});

test("exportar CSV: lo que se ve (filtrado y ordenado, todas las páginas), con encabezado, comillas escapadas y sin fórmulas de Excel", () => {
  const { tablaCsv, bajadas } = cargar();
  const csv = [{ label: "nombre", v: (r) => r.n }, { label: "valor", v: (r) => r.v }];
  const cont = { _tbl: { cols, rows: filas, filter: "", sortKey: "v", sortDir: 1, opts: { csv, csvNombre: "frutas.csv" } } };
  tablaCsv(cont);
  const t = bajadas.ultimo, lineas = t.replace(/^﻿/, "").split("\n");
  assert.ok(t.startsWith("﻿"), "con BOM: Excel lee bien los acentos");
  assert.strictEqual(lineas[0], '"nombre","valor"');
  assert.strictEqual(lineas.length, 5, "encabezado + las 4 filas, en el orden elegido");
  assert.deepStrictEqual(lineas.slice(1).map((l) => l.split(",").pop()), ['"1"', '"5"', '"20"', '"300"']);
  assert.ok(lineas.some((l) => l.startsWith(`"'=cmd|' /C calc'!A0"`)), "una celda que empieza con = no se interpreta como fórmula");
  assert.strictEqual(bajadas[0].nombre, "frutas.csv");
  cont._tbl.filter = "ce"; tablaCsv(cont);
  assert.strictEqual(bajadas.ultimo.replace(/^﻿/, "").split("\n").length, 2, "con filtro puesto exporta solo lo filtrado");
  assert.doesNotThrow(() => tablaCsv({ _tbl: { cols, rows: filas, filter: "", sortKey: null, sortDir: 1, opts: {} } }), "sin configuración de CSV no hace nada");
});

test("ofertas, premios y la lista de subastas/sorteos usan la tabla común y conservan los botones por fila y sus permisos", () => {
  assert.ok(/tabla\(\$\("ofTabla"\)/.test(a) && /csvNombre: "ofertas\.csv"/.test(a));
  assert.ok(/tabla\(\$\("premiosTabla"\)/.test(a) && /csvNombre: "premios\.csv"/.test(a));
  assert.ok(/tabla\(lista, \[/.test(a) && /csvNombre: crudActual \+ "\.csv"/.test(a));
  for (const b of ["data-ofdest=", "data-ofapr=", "data-premioact=", "data-vivo=", "data-pausar=", "data-cerrar=", "data-extender=", "data-segundo=", "data-pujas=", "data-link=", "data-edit=", "data-encact=", "data-comacc="]) assert.ok(a.includes(b), "se conserva " + b);
  assert.ok(/return !w \? "" : b\.estado === "rechazado"/.test(a), "Destacar y Aprobar igual solo con permiso de escritura");
  assert.ok(/cell: function \(p\) \{ return w \? '<button class="btn btn-sm btn-ghost" data-premioact=/.test(a), "Ocultar y Publicar solo con permiso de escritura");
  assert.ok(!/\.slice\(0, 60\)\s*;\s*\n\s*var PARA/.test(a), "las publicadas ya no se cortan en 60: hay páginas");
  assert.ok(/lista\._tbl\.filter = ""; lista\._tbl\.sortKey = null;/.test(a), "al cambiar de tipo no arrastra el filtro anterior");
});

test("la tabla común ofrece el botón de exportar solo cuando se le configura y tiene nombre accesible el filtro", () => {
  assert.ok(/\(opts\.csv \? '<button type="button" class="btn btn-sm btn-ghost tbl-csv">Exportar CSV<\/button>' : ''\)/.test(a));
  assert.ok(/if \(e\.target\.closest\("\.tbl-csv"\)\) \{ tablaCsv\(cont\); return; \}/.test(a));
  assert.ok(/aria-label="' \+ esc\(opts\.filterPh \|\| "Filtrar"\)/.test(a));
});
