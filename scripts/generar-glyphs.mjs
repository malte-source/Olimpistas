// Genera los glifos PBF (SDF) de Saira SemiBold y Saira Bold para MapLibre, sin servicios de terceros.
// Uso: instalá las dependencias fuera del proyecto (npm i --no-save @napi-rs/canvas @mapbox/tiny-sdf pbf), convertí public/assets/fonts/saira-600.woff2 y saira-700.woff2 a TTF (fonttools) y corré: node scripts/generar-glyphs.mjs public/assets/glyphs cmaps.json
import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import TinySDF from "@mapbox/tiny-sdf";
import { PbfWriter as Pbf } from "pbf";

const [, , salida = "./glyphs", cmapsPath = "./cmaps.json"] = process.argv;
const cmaps = JSON.parse(fs.readFileSync(cmapsPath, "utf8"));
const PILAS = [{ nombre: "Saira SemiBold", ttf: "saira-600.ttf", cmap: cmaps["600"] }, { nombre: "Saira Bold", ttf: "saira-700.ttf", cmap: cmaps["700"] }];
const RANGOS = [[0, 255], [256, 511], [8192, 8447]];
const TAM = 24, BUFFER = 3;

class SDFNodo extends TinySDF { _createCanvas(size) { return createCanvas(size, size); } }

function escribirGlifo(g, pbf) {
  if (g.id != null) pbf.writeVarintField(1, g.id);
  if (g.bitmap) pbf.writeBytesField(2, g.bitmap);
  pbf.writeVarintField(3, g.width);
  pbf.writeVarintField(4, g.height);
  pbf.writeSVarintField(5, g.left);
  pbf.writeSVarintField(6, g.top);
  pbf.writeVarintField(7, g.advance);
}
function escribirPila(p, pbf) {
  pbf.writeStringField(1, p.name);
  pbf.writeStringField(2, p.range);
  for (const g of p.glyphs) pbf.writeMessage(3, escribirGlifo, g);
}

for (const pila of PILAS) {
  const familia = pila.nombre.replace(/\s/g, "");
  GlobalFonts.registerFromPath(path.resolve(pila.ttf), familia);
  const sdf = new SDFNodo({ fontSize: TAM, buffer: BUFFER, radius: 8, cutoff: 0.25, fontFamily: familia, fontWeight: "normal" });
  // Línea base: MapLibre coloca el texto con un desplazamiento fijo de -17 px (a 24 px de cuerpo) pensado para que la
  // altura de versal quede centrada en el origen; con la altura de la "H" de Saira se obtiene el mismo centrado.
  const alturaH = sdf.draw("H").glyphTop;
  const ASCENDER = 17 + Math.round(alturaH / 2);
  const soportados = new Set(pila.cmap);
  const dir = path.join(salida, pila.nombre);
  fs.mkdirSync(dir, { recursive: true });
  let total = 0;
  for (const [a, b] of RANGOS) {
    const glyphs = [];
    for (let id = a; id <= b; id++) {
      if (!soportados.has(id) || id < 32) continue;
      const g = sdf.draw(String.fromCodePoint(id));
      const vacio = g.glyphWidth === 0 || g.glyphHeight === 0;
      glyphs.push({ id, bitmap: vacio ? null : Buffer.from(g.data.buffer, g.data.byteOffset, g.data.byteLength), width: g.glyphWidth, height: g.glyphHeight, left: g.glyphLeft, top: g.glyphTop - ASCENDER, advance: Math.round(g.glyphAdvance) });
    }
    if (!glyphs.length) continue;
    const pbf = new Pbf();
    pbf.writeMessage(1, escribirPila, { name: pila.nombre, range: `${a}-${b}`, glyphs });
    fs.writeFileSync(path.join(dir, `${a}-${b}.pbf`), Buffer.from(pbf.finish()));
    total += glyphs.length;
  }
  console.log(pila.nombre, "→", total, "glifos · altura H", alturaH, "· ascender", ASCENDER);
}
