"use strict";
// Concilia los pagos del PDF de Metrepay (que NO trae cédula) por NOMBRE EXACTO + tier.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/conciliar-pdf.js [--apply]
const { getStore } = require("../data/store");
const apply = process.argv.includes("--apply");
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
const TIERN = { premium: "Plus", kids: "Junior" };

const PAGOS = [
  ["Adolfo Samaniego", "premium"],
  ["Jorge Cardona", "premium"],
  ["Paola Lorena Mendoza Di Leva", "premium"],
  ["Cesar Lopez Bosio", "premium"],
  ["José Alvarenga", "kids"],
  ["José Luís Cespedes", "premium"],
  ["Olga Nathalia Mendoza", "premium"],
  ["Mathias Careaga", "premium"],
  ["Kevin Bruno", "kids"],
  ["Ana Paula Martínez Álvarez", "premium"],
  ["Guillermo Gabazza Sanabria", "premium"],
  ["Bianca Pereira", "premium"],
  ["María Silvia Díaz Heisecke", "premium"],
  ["Ian Cameron", "premium"],
  ["Rossana monserrath ramirez argaña", "premium"],
  ["Ruben Monges", "premium"],
  ["Carlos Martínez", "premium"],
  ["Bruno Costanzo", "premium"],
  ["Rodrigo Hidalgo", "premium"],
  ["Ki young kim", "premium"],
  ["Emilio Ignacio Ruiz Cabrera", "premium"],
  ["Ivan Montenegro", "premium"],
  ["Agustín René Torres Corrales", "premium"],
  ["Rebeca Molinas", "premium"],
  ["Robert carisimo", "premium"],
  ["Ivan Martinez", "premium"],
  ["Alejandro Zubizarreta", "premium"],
  ["Rodrigo Nogues", "premium"],
  ["Ruben Martinez", "premium"],
  ["Andrés Fernández", "premium"],
  ["Edilson Jose Robledo Recalde", "premium"],
  ["Ronald Chavez Rivaldi", "premium"],
  ["Oliver recalde", "premium"],
  ["Ever Tuaso", "premium"],
];

(async () => {
  const s = getStore();
  let act = 0, ya = 0, amb = 0, falta = 0;
  for (const [name, tier] of PAGOS) {
    // buscarSocios matchea UN término contra columnas separadas (nombre, apellido…),
    // así que el nombre completo nunca matchea. Buscamos por tokens (primero + último) y unimos.
    const toks = norm(name).split(" ").filter((t) => t.length >= 3);
    const queryToks = [toks[0], toks[toks.length - 1]].filter(Boolean);
    let cands = [];
    const vistos = new Set();
    for (const tok of queryToks) {
      let part = [];
      try { part = (await s.buscarSocios(tok, 200)) || []; } catch (e) {}
      for (const c of part) { if (!vistos.has(c.id)) { vistos.add(c.id); cands.push(c); } }
    }
    const exact = cands.filter((c) => norm((c.nombre || "") + " " + (c.apellido || "")) === norm(name));
    if (exact.length === 0) {
      falta++;
      console.log("❌ " + name + " (" + TIERN[tier] + ") → SIN cuenta" + (cands.length ? " | parciales: " + cands.slice(0, 3).map((c) => c.email).join(", ") : ""));
      continue;
    }
    if (exact.length > 1) { amb++; console.log("⚠️  " + name + " → AMBIGUO (" + exact.length + "): " + exact.map((c) => c.email).join(", ")); continue; }
    const socio = exact[0];
    const mem = await s.getMembresia(socio.id).catch(() => null);
    const cur = mem && (mem.tier_slug || mem.tierSlug);
    if (cur === tier) { ya++; console.log("✔️  " + name + " → " + socio.email + " | YA " + TIERN[tier]); continue; }
    console.log("✅ " + name + " → " + socio.email + " | " + (cur || "olimpista") + " → " + TIERN[tier]);
    if (apply) { await s.setMembresia(socio.id, { tierSlug: tier, ciclo: "anio", pagoRef: "metrepay-pdf" }); act++; }
  }
  console.log("\n" + (apply ? "APLICADO" : "(dry-run)") + " — ya: " + ya + " | a activar: contá ✅ | sin match: " + falta + " | ambiguos: " + amb + (apply ? " | activados: " + act : ""));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
