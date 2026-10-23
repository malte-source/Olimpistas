"use strict";
// Prepara los logos de los comercios de la Red de Beneficios: toma los PNG originales (grandes, con fondo transparente), recorta el margen
// vacío y los deja en WebP liviano (máx. 360×240) en public/assets/comercios/<slug>.webp. El slug sale del nombre del comercio.
//
//   node setup/procesar-logos.js "<carpeta con los PNG>"
//
// Solo procesa los archivos cuyo nombre coincide con un comercio de la muestra (data/beneficios-muestra.js) y avisa de los que no.
// Requiere `sharp` (devDependency): se corre en la máquina de desarrollo; los WebP resultantes se versionan en el repo.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { BENEFICIOS_MUESTRA } = require("../data/beneficios-muestra");

const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, " ").trim();
const slug = (s) => norm(s).replace(/ /g, "-");
// El archivo puede traer un sufijo ("SUPERSEIS S6"): se acepta si empieza con el nombre del comercio.
const comercios = BENEFICIOS_MUESTRA.map((x) => x.comercio.nombre);
const buscar = (archivo) => {
  const a = norm(archivo);
  return comercios.filter((c) => a === norm(c) || a.startsWith(norm(c) + " ")).sort((x, y) => norm(y).length - norm(x).length)[0] || null;
};

(async () => {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) { console.error('Uso: node setup/procesar-logos.js "<carpeta con los PNG>"'); process.exit(1); }
  const salida = path.join(__dirname, "..", "public", "assets", "comercios");
  fs.mkdirSync(salida, { recursive: true });
  const hechos = [], sin = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.(png|jpe?g|webp)$/i.test(x)).sort()) {
    const c = buscar(f);
    if (!c) { sin.push(f); continue; }
    const destino = path.join(salida, slug(c) + ".webp");
    await sharp(path.join(dir, f)).trim({ threshold: 8 }).resize({ width: 360, height: 240, fit: "inside", withoutEnlargement: true }).webp({ quality: 88, alphaQuality: 95 }).toFile(destino);
    hechos.push([c, slug(c) + ".webp", Math.round(fs.statSync(destino).size / 1024) + " KB"]);
  }
  hechos.forEach((h) => console.log("ok   " + h[0].padEnd(22) + h[1].padEnd(28) + h[2]));
  sin.forEach((s) => console.log("sin comercio en la muestra (se omite): " + s));
  console.log(`\n${hechos.length} logos listos en public/assets/comercios. Comercios de la muestra sin logo: ${comercios.filter((c) => !hechos.some((h) => h[0] === c)).join(", ") || "ninguno"}.`);
})().catch((e) => { console.error("Falló: " + e.message); process.exit(1); });
