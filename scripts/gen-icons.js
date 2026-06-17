"use strict";

/**
 * gen-icons.js — Genera los íconos PNG del PWA a partir de public/assets/logo.svg.
 *
 * Uso (una sola vez, o cuando cambie el logo):
 *   node scripts/gen-icons.js
 *
 * Cuando Olimpia entregue el logo oficial, reemplazar logo.svg y volver a correr.
 * sharp es devDependency: no se necesita en runtime ni en la imagen de producción.
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ASSETS = path.join(__dirname, "..", "public", "assets");
const svg = fs.readFileSync(path.join(ASSETS, "logo.svg"));
const BG = { r: 11, g: 11, b: 15, alpha: 1 }; // var(--negro)

async function make(size, padRatio, file) {
  const inner = Math.round(size * (1 - padRatio * 2));
  const logo = await sharp(svg)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  const off = Math.round((size - inner) / 2);
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, top: off, left: off }])
    .png().toFile(path.join(ASSETS, file));
  console.log("  ✓", file, `(${size}px)`);
}

(async () => {
  console.log("Generando íconos PWA…");
  await make(192, 0.18, "icon-192.png");
  await make(512, 0.18, "icon-512.png");
  await make(512, 0.26, "maskable-512.png");  // margen seguro para íconos adaptables
  await make(180, 0.16, "apple-touch-icon.png");
  await make(32, 0.10, "favicon-32.png");
  console.log("Listo.");
})().catch((e) => { console.error(e); process.exit(1); });
