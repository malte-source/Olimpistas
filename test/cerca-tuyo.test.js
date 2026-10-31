"use strict";
// N3 · Cerca tuyo: orden "Más cerca" en Beneficios. La ubicación se usa solo en el teléfono: nunca se manda al servidor.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const js = fs.readFileSync(path.join(__dirname, "..", "public", "js", "socio.js"), "utf8");
const i18n = fs.readFileSync(path.join(__dirname, "..", "public", "js", "i18n.js"), "utf8");

// Corre el código REAL del bloque <N3> de socio.js.
const bloque = js.split("// <N3>")[1].split("// </N3>")[0].split("\n").slice(1).join("\n");
const TXT = { bx_dist_m: "a {n} m", pn_km: "a {km} km" };
const N3 = new Function("T", "LOC", bloque + "\nreturn { distanciaKm, conUbicacion, kmDesde, porCercania, distTxt };")((k) => TXT[k], "es-PY");

const ASUNCION = { lat: -25.2637, lng: -57.5759 };

test("la distancia entre dos puntos es la real (Asunción–Luque ≈ 9 km), simétrica y cero en el mismo lugar", () => {
  const d = N3.distanciaKm(ASUNCION.lat, ASUNCION.lng, -25.2667, -57.4872);
  assert.ok(Math.abs(d - 8.9) < 0.3, "Asunción–Luque: " + d);
  assert.strictEqual(N3.distanciaKm(ASUNCION.lat, ASUNCION.lng, ASUNCION.lat, ASUNCION.lng), 0);
  assert.ok(Math.abs(N3.distanciaKm(1, 2, 3, 4) - N3.distanciaKm(3, 4, 1, 2)) < 1e-9);
  assert.ok(Math.abs(N3.distanciaKm(0, 0, 0, 180) - 20015) < 20, "media vuelta al mundo");
});

test("un comercio tiene ubicación solo si lat y lng son números válidos (las coordenadas pueden llegar como texto)", () => {
  for (const [lat, lng, ok] of [[-25.2, -57.5, true], ["-25.2", "-57.5", true], [0, 0, true], [null, -57.5, false], [-25.2, undefined, false], ["", "", false], ["abc", "1", false], [NaN, 1, false]]) {
    assert.strictEqual(N3.conUbicacion({ comercio_lat: lat, comercio_lng: lng }), ok, JSON.stringify([lat, lng]));
  }
});

test("las distancias se calculan por comercio y la lista queda de más cerca a más lejos, con los que no tienen ubicación al final", () => {
  const items = [
    { id: "lejos", comercio_lat: -25.5, comercio_lng: -57.0 },
    { id: "sin" },
    { id: "cerca", comercio_lat: "-25.2650", comercio_lng: "-57.5700" },
    { id: "medio", comercio_lat: -25.30, comercio_lng: -57.60 },
    { id: "sin2", comercio_lat: null, comercio_lng: null },
  ];
  N3.kmDesde(items, ASUNCION);
  assert.strictEqual(items.find((x) => x.id === "sin")._km, null);
  assert.strictEqual(items.find((x) => x.id === "sin2")._km, null);
  assert.deepStrictEqual(items.slice().sort(N3.porCercania).map((x) => x.id).slice(0, 3), ["cerca", "medio", "lejos"]);
  assert.deepStrictEqual(items.slice().sort(N3.porCercania).slice(3).map((x) => x.id).sort(), ["sin", "sin2"]);
});

test("el texto de la distancia: metros redondeados a 10 si es menos de 1 km, y km con un decimal", () => {
  assert.strictEqual(N3.distTxt(0.35), "a 350 m");
  assert.strictEqual(N3.distTxt(0.004), "a 10 m", "nunca '0 m'");
  assert.strictEqual(N3.distTxt(0.999), "a 1000 m");
  assert.strictEqual(N3.distTxt(1), "a 1 km");
  assert.strictEqual(N3.distTxt(1.26), "a 1,3 km");
  assert.strictEqual(N3.distTxt(12.04), "a 12 km");
});

test("privacidad y cableado: el orden solo aparece si hay comercios con ubicación; el manejador no manda la posición a ningún lado; textos es y en", () => {
  assert.ok(/items\.some\(conUbicacion\) \? '<option value="cerca">'/.test(js));
  assert.ok(js.indexOf("// <N3>") < js.indexOf("const barra = "), "los ayudantes se definen antes de la barra que los usa (si no, la lista de Beneficios no se dibuja)");
  const manejador = js.split('#bxOrden").addEventListener("change"')[1].split("\n    });")[0];
  assert.ok(/getCurrentPosition/.test(manejador) && /kmDesde\(items, st\.pos\)/.test(manejador));
  assert.ok(!/\bapi\(|fetch\(|sendBeacon|XMLHttpRequest/.test(manejador), "la ubicación nunca se manda al servidor");
  assert.ok(/st\.orden === "cerca" && st\.pos/.test(js));
  for (const k of ["bx_o_cerca", "bx_dist_m", "bx_cerca_priv"]) assert.strictEqual((i18n.match(new RegExp("\\b" + k + ":", "g")) || []).length, 2, k + " en es y en");
});
