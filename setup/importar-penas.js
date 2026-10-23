"use strict";
// Carga las peñas y su padrón de miembros desde el informe del club (Excel).
//
//   node setup/importar-penas.js "Informe_Penas.xlsx"              simula: muestra qué cargaría, sin tocar nada
//   OLIMPISTAS_DATABASE_URL=... node setup/importar-penas.js "Informe_Penas.xlsx" --aplicar
//
// Hoja "Detalle", columnas: Peña · Nombre y Apellido · N° Socio · Cédula · Estado. Las peñas entran como VERIFICADAS. El listado queda en un
// padrón aparte (no crea cuentas de personas que no se registraron): quien se registre o valide su cédula se suma solo a su peña, y los que
// ya tienen cuenta con esa cédula reciben su peña ahora (la primera según el informe). Es idempotente: correrlo de nuevo actualiza, no duplica.
// El estado de la cuota (al día / en mora) lo ve solo el admin (owner).
const path = require("path");
const XLSX = require("xlsx");
const { armarPlan, aplicarPlan } = require("../lib/penas-padron");

const args = process.argv.slice(2);
const archivo = args.find((a) => !a.startsWith("--"));
const aplicar = args.includes("--aplicar");
if (!archivo) { console.error("Uso: node setup/importar-penas.js <informe.xlsx> [--aplicar]"); process.exit(1); }

(async () => {
  const wb = XLSX.readFile(path.resolve(archivo));
  const hoja = wb.Sheets["Detalle"] || wb.Sheets[wb.SheetNames[wb.SheetNames.length - 1]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: "", raw: false }).slice(1).filter((f) => f[0] || f[1]);
  const plan = armarPlan(filas);
  console.log(`Informe: ${plan.filas} filas · ${plan.penas.length} peñas · ${plan.sinCedula} sin cédula · ${plan.repetidasEnOtraPena} personas que figuran también en otra peña · ${plan.cedulaCompartida} con una cédula que ya tenía otro miembro de su peña (se cargan sin cédula) · ${plan.descartadas} filas repetidas descartadas`);
  const estados = { al_dia: 0, en_mora: 0, sin_dato: 0 };
  for (const p of plan.penas) { p.miembros.forEach((m) => estados[m.estado_cuota]++); console.log("  " + p.nombre.padEnd(40) + String(p.miembros.length).padStart(5) + (p.ciudad ? "  (" + p.ciudad + ")" : "")); }
  console.log(`Estados: ${estados.al_dia} al día · ${estados.en_mora} en mora · ${estados.sin_dato} sin dato`);
  if (!aplicar) { console.log("\nSimulación: no se cargó nada. Con --aplicar se carga en la base de OLIMPISTAS_DATABASE_URL."); return; }
  if (!process.env.OLIMPISTAS_DATABASE_URL) { console.error("Falta OLIMPISTAS_DATABASE_URL para --aplicar."); process.exit(1); }
  const { getStore } = require("../data/store");
  const store = getStore();
  const r = await aplicarPlan(store, plan, { fuente: "informe " + path.basename(archivo) });
  console.log("\nCargado:", JSON.stringify(r));
  process.exit(0);
})().catch((e) => { console.error("Falló: " + e.message); process.exit(1); });
