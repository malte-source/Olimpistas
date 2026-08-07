"use strict";
// Crea la subasta de la camiseta de Tim Payne (48h, puja Plus y Socio).
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/crear-subasta-payne.js
// Opcionales por env: PRECIO_INICIAL, INCREMENTO, HORAS
const { getStore } = require("../data/store");

(async () => {
  const store = getStore();
  const horas = Number(process.env.HORAS || 48);
  const termina = new Date(Date.now() + horas * 3600 * 1000).toISOString();
  const s = await store.crearSubasta({
    titulo: "Camiseta de Tim Payne — debut y gol",
    descripcion: "La camiseta que Tim Payne usó en su primer partido con Olimpia, donde marcó su primer gol. Pieza única del debut. El ganador paga online para confirmarla; la entrega se coordina por privado.",
    emoji: "👕",
    nivel_min: "premium", // puja Plus y Socio
    precio_inicial: Number(process.env.PRECIO_INICIAL || 500000),
    incremento: Number(process.env.INCREMENTO || 50000),
    termina,
    estado: "activa",
  });
  console.log("OK · subasta creada:", s.id, "· cierra", termina);
  process.exit(0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
