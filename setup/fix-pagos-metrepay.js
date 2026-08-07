"use strict";
// Activa pagos Metrepay (Plus) que no auto-activaron. Matchea por cédula (tolera el
// dígito verificador); si no, por nombre EXACTO (único). Reporta los ambiguos/sin cuenta.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/fix-pagos-metrepay.js [--apply]
const { getStore } = require("../data/store");
const apply = process.argv.includes("--apply");
const TIER = "premium"; // todos "Categoría Plus"

const PAGOS = [
  { ced: "5664617",   name: "Ana Paula Martínez Álvarez" },
  { ced: "378882-2",  name: "Guillermo Gabazza Sanabria" },
];

const digits = (s) => String(s || "").replace(/\D/g, "");
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

(async () => {
  const s = getStore();
  let ok = 0, ya = 0, falta = 0;
  for (const p of PAGOS) {
    const full = digits(p.ced), sinDv = full.slice(0, -1);
    let socio = await s.getSocioByCedula(full);
    let via = "cédula";
    if (!socio && sinDv.length > 1) socio = await s.getSocioByCedula(sinDv);
    if (!socio && s.buscarSocios) {
      let cands = [];
      try { cands = (await s.buscarSocios(p.name)) || []; } catch (e) {}
      const exact = cands.filter((c) => norm((c.nombre || "") + " " + (c.apellido || "")) === norm(p.name));
      if (exact.length === 1) { socio = exact[0]; via = "nombre exacto"; }
      else if (exact.length > 1) via = `nombre AMBIGUO (${exact.length})`;
      else if (cands.length) via = `solo parciales (${cands.length})`;
    }
    if (!socio) { falta++; console.log(`❌ ${p.name} (${p.ced}) → SIN match [${via}]`); continue; }
    const mem = await s.getMembresia(socio.id).catch(() => null);
    const tierActual = mem && (mem.tier_slug || mem.tierSlug);
    if (tierActual === "premium") { ya++; console.log(`✔️  ${p.name} (${p.ced}) → ${socio.email} | YA premium [${via}]`); continue; }
    console.log(`✅ ${p.name} (${p.ced}) → ${socio.email} | actual: ${tierActual || "?"} → premium [${via}]`);
    if (apply) { await s.setMembresia(socio.id, { tierSlug: TIER, ciclo: "anio", pagoRef: "metrepay-retro" }); ok++; }
  }
  console.log(`\n${apply ? "APLICADO" : "(dry-run)"} — a activar: contá los ✅ | ya premium: ${ya} | sin match: ${falta}` + (apply ? ` | activados: ${ok}` : ""));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
