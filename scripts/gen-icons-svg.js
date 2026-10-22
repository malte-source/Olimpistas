"use strict";
// Genera public/assets/icons.svg (sprite SVG propio · handoff v2, 10-iconos.md).
// Grilla 24, trazo 1.8, extremos y uniones redondeados, fill none. Uso:
//   <svg class="ic"><use href="/assets/icons.svg#i-inicio"/></svg>      (línea)
//   <svg class="ic"><use href="/assets/icons.svg#i-inicio-f"/></svg>    (rellena: pestaña activa, cuadrados de color)
// Same-origin: la CSP lo permite. El estilo de línea lo pone `.ic` en styles.css.
// Uso: node scripts/gen-icons-svg.js
const fs = require("fs");
const path = require("path");

// id → [línea, rellena?]. La rellena usa fill="currentColor" stroke="none" y los detalles interiores calados (evenodd).
const ICONOS = {
  // Pestañas
  inicio: ['<path d="M4 11.2 12 4l8 7.2"/><path d="M6 9.9V19a1 1 0 0 0 1 1h3.5v-5h3v5H17a1 1 0 0 0 1-1V9.9"/>',
    '<path d="M12 3.1 2.7 11.4a.9.9 0 0 0 .6 1.6H5v6a2 2 0 0 0 2 2h3v-5.5h4V21h3a2 2 0 0 0 2-2v-6h1.7a.9.9 0 0 0 .6-1.6z"/>'],
  partidos: ['<ellipse cx="12" cy="12" rx="9" ry="6.6"/><ellipse cx="12" cy="12" rx="4.6" ry="2.7"/><path d="M12 5.4v3.9M12 14.7v3.9"/>',
    '<path fill-rule="evenodd" d="M12 4.9c5 0 9.1 3 9.1 7.1s-4.1 7.1-9.1 7.1S2.9 16.1 2.9 12 7 4.9 12 4.9zm0 4.6c-2.8 0-5.2 1.2-5.2 2.5s2.4 2.5 5.2 2.5 5.2-1.2 5.2-2.5S14.8 9.5 12 9.5z"/>'],
  carnet: ['<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.8" cy="11" r="2"/><path d="M5.6 16.2c.5-1.4 1.7-2.1 3.2-2.1s2.7.7 3.2 2.1M14.5 10h4M14.5 13.5h3"/>',
    '<path fill-rule="evenodd" d="M5.5 5h13A2.5 2.5 0 0 1 21 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9A2.5 2.5 0 0 1 5.5 5zM8.8 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5.3 16.4c.5-1.5 1.8-2.4 3.5-2.4s3 .9 3.5 2.4zM14.5 9.4h4a.6.6 0 0 1 0 1.2h-4a.6.6 0 0 1 0-1.2zM14.5 12.9h3a.6.6 0 0 1 0 1.2h-3a.6.6 0 0 1 0-1.2z"/>'],
  beneficios: ['<path d="M20.6 13.4 13.4 20.6a1.7 1.7 0 0 1-2.4 0l-6.8-6.8A1.7 1.7 0 0 1 3.7 12.6V5.8a2 2 0 0 1 2-2h6.8c.5 0 .9.2 1.2.5l6.9 6.8a1.7 1.7 0 0 1 0 2.3z"/><circle cx="8.3" cy="8.3" r="1.2"/>',
    '<path fill-rule="evenodd" d="M12.5 3.8H5.7a2 2 0 0 0-2 2v6.8c0 .5.2.9.5 1.2l6.8 6.8a1.7 1.7 0 0 0 2.4 0l7.2-7.2a1.7 1.7 0 0 0 0-2.4l-6.9-6.8a1.7 1.7 0 0 0-1.2-.4zM8.3 7a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/>'],
  puntos: ['<circle cx="12" cy="9" r="5.2"/><path d="M8.6 13.4 7 21l5-3 5 3-1.6-7.6"/>',
    '<path d="M12 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM8 15.2 6.4 21.6a.6.6 0 0 0 .9.6L12 19.5l4.7 2.7a.6.6 0 0 0 .9-.6L16 15.2A7.6 7.6 0 0 1 12 16.4a7.6 7.6 0 0 1-4-1.2z"/>'],
  descubrir: ['<circle cx="12" cy="12" r="9"/><path d="m15.2 8.8-1.7 4.7-4.7 1.7 1.7-4.7z"/>',
    '<path fill-rule="evenodd" d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zm3.6 6-1.9 5.2-5.2 1.9 1.9-5.2z"/>'],
  perfil: ['<circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.7 3.1-5.8 7-5.8s7 2.1 7 5.8"/>',
    '<circle cx="12" cy="8" r="4.2"/><path d="M4.2 20.4c0-4 3.4-6.3 7.8-6.3s7.8 2.3 7.8 6.3a.6.6 0 0 1-.6.6H4.8a.6.6 0 0 1-.6-.6z"/>'],
  // Ajustes
  pena: ['<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.4-3 2.6-4.5 5.5-4.5s5.1 1.5 5.5 4.5"/><circle cx="17" cy="9.5" r="2.4"/><path d="M16 14.6c2.7-.3 4.5 1.1 4.9 3.9"/>',
    '<circle cx="9" cy="8.5" r="3.4"/><path d="M2.8 19.4c.4-3.4 3-5.4 6.2-5.4s5.8 2 6.2 5.4a.6.6 0 0 1-.6.6H3.4a.6.6 0 0 1-.6-.6z"/><circle cx="17" cy="9.5" r="2.8"/><path d="M16.2 14.1c2.8-.3 4.9 1.3 5.4 4.2.1.4-.2.7-.6.7h-3.6c-.1-1.9-.6-3.4-1.4-4.5z"/>'],
  luna: ['<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'],
  sol: ['<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'],
  idioma: ['<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9S14.6 18.4 12 21c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/>'],
  avisos: ['<path d="M6 17v-6a6 6 0 0 1 12 0v6l1.5 2h-15z"/><path d="M10 21a2 2 0 0 0 4 0"/>',
    '<path d="M12 3a6.5 6.5 0 0 0-6.5 6.5V17L3.8 19.2a.6.6 0 0 0 .5 1h15.4a.6.6 0 0 0 .5-1L18.5 17V9.5A6.5 6.5 0 0 0 12 3zM9.6 21a2.4 2.4 0 0 0 4.8 0z"/>'],
  ayuda: ['<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1.1.9-1.1 1.7M12 17h.01"/>'],
  salir: ['<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l4-4-4-4M14 12H4"/>'],
  // Chat
  chat: ['<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    '<path d="M12.5 3.5a8.5 8.5 0 0 0-7.7 12.1L3.6 20a.6.6 0 0 0 .8.7l4.6-1.3A8.5 8.5 0 1 0 12.5 3.5z"/>'],
  enviar: ['<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>'],
  persona: ['<circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.7 3.1-5.8 7-5.8s7 2.1 7 5.8"/>'],
  // Estados
  "check-circulo": ['<circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.8 2.8 5.3-5.6"/>',
    '<path fill-rule="evenodd" d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zm4.5 7.2a.9.9 0 0 0-1.3-1.2l-4.6 4.9-1.9-1.9a.9.9 0 0 0-1.3 1.3l2.6 2.6a.9.9 0 0 0 1.3 0z"/>'],
  "error-circulo": ['<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    '<path fill-rule="evenodd" d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zm3.7 7.2-2.3 2.3 2.3 2.3a.9.9 0 0 1-1.3 1.3L12 13.3l-2.4 2.3a.9.9 0 0 1-1.3-1.3l2.4-2.3-2.4-2.3a.9.9 0 0 1 1.3-1.3L12 10.7l2.4-2.3a.9.9 0 0 1 1.3 1.3z"/>'],
  candado: ['<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'],
  reloj: ['<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  verificado: ['<path d="M12 3l2.4 1.7 2.9-.1 1 2.7 2.3 1.8-.9 2.8.9 2.8-2.3 1.8-1 2.7-2.9-.1L12 21l-2.4-1.7-2.9.1-1-2.7-2.3-1.8.9-2.8-.9-2.8 2.3-1.8 1-2.7 2.9.1z"/><path d="m8.6 12.2 2.4 2.4 4.4-4.6"/>',
    '<path fill-rule="evenodd" d="M12 2.4l2.5 1.8 3-.1 1 2.8 2.4 1.9-.9 2.9.9 2.9-2.4 1.9-1 2.8-3-.1L12 21.6l-2.5-1.8-3 .1-1-2.8-2.4-1.9.9-2.9-.9-2.9 2.4-1.9 1-2.8 3 .1zm4.3 6.9a.9.9 0 0 0-1.3-1.2l-3.8 4-1.6-1.6a.9.9 0 0 0-1.3 1.3l2.3 2.2a.9.9 0 0 0 1.3 0z"/>'],
  // Panel del club
  tablero: ['<rect x="3.5" y="3.5" width="7" height="9" rx="2"/><rect x="13.5" y="3.5" width="7" height="5" rx="2"/><rect x="13.5" y="11.5" width="7" height="9" rx="2"/><rect x="3.5" y="15.5" width="7" height="5" rx="2"/>',
    '<rect x="3" y="3" width="8" height="10" rx="2.3"/><rect x="13" y="3" width="8" height="6" rx="2.3"/><rect x="13" y="11" width="8" height="10" rx="2.3"/><rect x="3" y="15" width="8" height="6" rx="2.3"/>'],
  decisiones: ['<rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="m8 9.5 1.5 1.5L12 8.5M8 15l1.5 1.5L12 14M14.5 10h3M14.5 15.5h3"/>'],
  hinchas: ['<circle cx="12" cy="8" r="3.2"/><circle cx="5.5" cy="10" r="2.2"/><circle cx="18.5" cy="10" r="2.2"/><path d="M6.2 19c.3-3 2.4-4.6 5.8-4.6s5.5 1.6 5.8 4.6M2.2 17.5c.3-2 1.5-3.1 3.3-3.1M21.8 17.5c-.3-2-1.5-3.1-3.3-3.1"/>'],
  atencion: ['<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="3" y="13" width="4" height="6" rx="1.6"/><rect x="17" y="13" width="4" height="6" rx="1.6"/><path d="M19 19c0 1.6-1.6 2.5-4 2.5"/>'],
  campanas: ['<path d="M4 10v4h3l7 4V6L7 10z"/><path d="M17.5 9.3a4.2 4.2 0 0 1 0 5.4"/>'],
  penas: ['<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.4-3 2.6-4.5 5.5-4.5s5.1 1.5 5.5 4.5"/><circle cx="17" cy="9.5" r="2.4"/><path d="M16 14.6c2.7-.3 4.5 1.1 4.9 3.9"/>'],
  subastas: ['<rect x="8.6" y="3.6" width="9" height="4.4" rx="1.2" transform="rotate(45 13.1 5.8)"/><path d="m9.4 11.3 4.2 4.2M3.8 20.2l6.9-6.9"/><path d="M12.5 21h8"/>'],
  estadio: ['<ellipse cx="12" cy="12" rx="9" ry="6.6"/><ellipse cx="12" cy="12" rx="4.6" ry="2.7"/><path d="M12 5.4v3.9M12 14.7v3.9"/>'],
  integraciones: ['<circle cx="12" cy="12" r="2.5"/><circle cx="5" cy="6" r="1.8"/><circle cx="19" cy="6" r="1.8"/><circle cx="5" cy="18" r="1.8"/><circle cx="19" cy="18" r="1.8"/><path d="m6.4 7.2 3.7 3.6M17.6 7.2l-3.7 3.6M6.4 16.8l3.7-3.6M17.6 16.8l-3.7-3.6"/>'],
  roles: ['<path d="M12 3 5 6v5.5c0 4.3 2.9 7.8 7 9 4.1-1.2 7-4.7 7-9V6z"/><circle cx="12" cy="10.2" r="2"/><path d="M8.8 15.6c.8-1.4 1.9-2 3.2-2s2.4.6 3.2 2"/>'],
  // Acciones
  "chevron-derecha": ['<path d="m9 5 7 7-7 7"/>'],
  "chevron-izquierda": ['<path d="m15 5-7 7 7 7"/>'],
  "chevron-abajo": ['<path d="m5 9 7 7 7-7"/>'],
  compartir: ['<circle cx="6" cy="12" r="2.4"/><circle cx="17.5" cy="6" r="2.4"/><circle cx="17.5" cy="18" r="2.4"/><path d="m8.2 10.8 7.1-3.6M8.2 13.2l7.1 3.6"/>'],
  qr: ['<rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/><path d="M14 14h3v3h-3zM20.5 14v3M14 20.5h1M20.5 20.5h.01"/>'],
  liberar: ['<path d="M8 3.5h8a1.5 1.5 0 0 1 1.4 1l1.1 4.5H5.5l1.1-4.5A1.5 1.5 0 0 1 8 3.5z"/><path d="M5 9.5h14v5H5zM7 14.5V20M17 14.5V20"/>'],
  pagar: ['<rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M3 10.5h18M7 15h3"/>'],
  pujar: ['<rect x="8.6" y="3.6" width="9" height="4.4" rx="1.2" transform="rotate(45 13.1 5.8)"/><path d="m9.4 11.3 4.2 4.2M3.8 20.2l6.9-6.9"/><path d="M12.5 21h8"/>'],
  ahorro: ['<path d="M5 11.5c0-3.3 3-5.5 7-5.5 1.3 0 2.5.2 3.5.7L19 5v3.3c1 .9 1.5 2 1.5 3.2 0 1.6-.9 3-2.3 3.9V18a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-.5h-3V18a1 1 0 0 1-1 1H8.2a1 1 0 0 1-1-1v-2.7C5.9 14.4 5 13.1 5 11.5z"/><path d="M9.5 10.2h.01"/>'],
  tienda: ['<path d="M4 9.5 5.3 4.8A1 1 0 0 1 6.2 4h11.6a1 1 0 0 1 .9.8L20 9.5"/><path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5.5 12.5V20h13v-7.5M10 20v-4.5h4V20"/>'],
  mas: ['<path d="M12 5v14M5 12h14"/>'],
  cerrar: ['<path d="M6 6l12 12M18 6 6 18"/>'],
  buscar: ['<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'],
  editar: ['<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m14 7 3 3"/>'],
  descargar: ['<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>'],
  link: ['<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'],
  pausa: ['<path d="M8 5v14M16 5v14"/>'],
  ojo: ['<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'],
  regalo: ['<rect x="3.5" y="8.5" width="17" height="4" rx="1.2"/><path d="M5 12.5V20h14v-7.5M12 8.5V20M12 8.5C10 8.5 8 8 8 6.2 8 5 9 4.3 10 4.3c1.3 0 2 1.8 2 4.2zM12 8.5c2 0 4-.5 4-2.3 0-1.2-1-1.9-2-1.9-1.3 0-2 1.8-2 4.2z"/>'],
  entrada: ['<path d="M3.5 9V7a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v2a2.5 2.5 0 0 0 0 5v2a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-2a2.5 2.5 0 0 0 0-5z"/><path d="M14.5 5.5v13" stroke-dasharray="1.6 2.2"/>'],
  play: ['<circle cx="12" cy="12" r="9"/><path d="m10.2 8.8 5 3.2-5 3.2z"/>'],
  pin: ['<path d="M12 21s6.5-5.7 6.5-11A6.5 6.5 0 0 0 5.5 10c0 5.3 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'],
  info: ['<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>'],
  tuerca: ['<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6"/>'],
};

let out = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n';
out += "<!-- Generado por scripts/gen-icons-svg.js · no editar a mano. Línea: i-<id>. Rellena: i-<id>-f (la pestaña activa y los cuadrados de color). -->\n";
for (const [id, [linea, rellena]] of Object.entries(ICONOS)) {
  out += `<symbol id="i-${id}" viewBox="0 0 24 24">${linea}</symbol>\n`;
  if (rellena) out += `<symbol id="i-${id}-f" viewBox="0 0 24 24" fill="currentColor" stroke="none">${rellena}</symbol>\n`;
}
out += "</svg>\n";
fs.writeFileSync(path.join(__dirname, "..", "public", "assets", "icons.svg"), out);
console.log(`ok: ${Object.keys(ICONOS).length} íconos, ${Object.values(ICONOS).filter((v) => v[1]).length} con variante rellena → public/assets/icons.svg (${out.length} bytes)`);
