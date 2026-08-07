"use strict";
// Activa membresías matcheando por CÉDULA (más confiable que por nombre).
// La cédula del pago puede venir con DV ("448108-9") o sin él; comparamos la base numérica.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/activar-por-cedula.js [--apply]
const { getStore } = require("../data/store");
const apply = process.argv.includes("--apply");
const baseCed = (c) => String(c || "").replace(/[.\s]/g, "").split("-")[0].replace(/\D/g, "");
const TIERN = { premium: "Plus", kids: "Junior" };

// [cédula, tier, nombre(referencia)]
const PAGOS = [
  ["1517066", "premium", "Jorge Cardona"],
  ["3535113-6", "premium", "José Luís Cespedes"],
  ["5654071", "premium", "Mathias Careaga"],
];

(async () => {
  const s = getStore();
  let act = 0, ya = 0, amb = 0, falta = 0;
  for (const [ced, tier, name] of PAGOS) {
    const base = baseCed(ced);
    let cands = [];
    try { cands = (await s.buscarSocios(base, 50)) || []; } catch (e) {}
    const exact = cands.filter((c) => baseCed(c.cedula) === base && base.length >= 5);
    if (exact.length === 0) {
      falta++;
      console.log("❌ " + name + " (céd " + ced + ") → SIN cuenta con esa cédula" + (cands.length ? " | parciales: " + cands.slice(0, 3).map((c) => c.email + "/" + (c.cedula || "—")).join(", ") : ""));
      continue;
    }
    if (exact.length > 1) { amb++; console.log("⚠️  " + name + " (céd " + ced + ") → AMBIGUO (" + exact.length + "): " + exact.map((c) => c.email).join(", ")); continue; }
    const socio = exact[0];
    const mem = await s.getMembresia(socio.id).catch(() => null);
    const cur = mem && (mem.tier_slug || mem.tierSlug);
    if (cur === tier) { ya++; console.log("✔️  " + name + " → " + socio.email + " | YA " + TIERN[tier]); continue; }
    console.log("✅ " + name + " → " + socio.email + " (céd " + socio.cedula + ") | " + (cur || "olimpista") + " → " + TIERN[tier]);
    if (apply) { await s.setMembresia(socio.id, { tierSlug: tier, ciclo: "anio", pagoRef: "metrepay-cedula" }); act++; }
  }
  console.log("\n" + (apply ? "APLICADO" : "(dry-run)") + " — ya: " + ya + " | sin match: " + falta + " | ambiguos: " + amb + (apply ? " | activados: " + act : ""));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
