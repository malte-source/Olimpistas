"use strict";
// Exporta TUTS, FAQS, AUD y CATS del prototipo del Centro de ayuda a data/ayuda.json (el contenido se edita en el prototipo
// y se vuelve a exportar). Uso: node scripts/exportar-ayuda.js "<ruta a Centro de Ayuda Olimpistas.dc.html>"
// El archivo queda en data/ (no en public/) a propósito: la API /api/ayuda filtra por perfil y los perfiles del club
// (Comisión Directiva, Marketing, Comercial, Operaciones, Atención, Admin) solo se muestran con sesión del panel.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const origen = process.argv[2];
if (!origen) { console.error('Falta la ruta del prototipo: node scripts/exportar-ayuda.js "<archivo.dc.html>"'); process.exit(1); }
const html = fs.readFileSync(origen, "utf8");
const ini = html.indexOf("const AUD = {"), fin = html.indexOf("class Component");
if (ini < 0 || fin < 0) { console.error("No encuentro AUD/TUTS/FAQS en el prototipo."); process.exit(1); }

const ctx = {};
vm.createContext(ctx);
vm.runInContext(html.slice(ini, fin) + "\nthis.__out = { AUD, CATS, TUTS, FAQS };", ctx);
const { AUD, CATS, TUTS, FAQS } = ctx.__out;

const out = {
  aud: Object.entries(AUD).map(([id, a]) => ({ id, label: a.label, grupo: a.grupo, desc: a.desc, club: a.grupo === "Club", tile: a.tile })),
  cats: Object.fromEntries(Object.entries(CATS).map(([id, [label]]) => [id, label])),
  tuts: TUTS.map((t) => ({ aud: t.aud, cat: t.cat, titulo: t.titulo, bajada: t.bajada, min: t.min, pasos: t.pasos.map(([titulo, texto, donde]) => ({ titulo, texto, donde: donde || "" })) })),
  faqs: FAQS.map((f) => ({ aud: f.aud, cat: f.cat, q: f.q, a: f.a, d: f.d })),
};
const destino = path.join(__dirname, "..", "data", "ayuda.json");
fs.writeFileSync(destino, JSON.stringify(out, null, 1) + "\n");
console.log(`ok: ${out.tuts.length} tutoriales, ${out.faqs.length} preguntas, ${out.aud.length} perfiles → ${path.relative(process.cwd(), destino)}`);
