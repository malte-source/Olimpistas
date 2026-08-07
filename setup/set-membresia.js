"use strict";
// Ajusta la membresía de un socio. Uso:
//   OLIMPISTAS_DATABASE_URL=... node setup/set-membresia.js <email> <tierSlug>
const { getStore } = require("../data/store");
const email = process.argv[2], tier = process.argv[3] || "olimpista";
(async () => {
  const s = getStore();
  const socio = await s.getSocioByEmail(email);
  if (!socio) { console.error("No existe:", email); process.exit(1); }
  await s.setMembresia(socio.id, { tierSlug: tier, ciclo: "anio" });
  if (tier === "olimpista") await s.updateSocio(socio.id, { es_socio_olimpia: false });
  console.log("OK →", email, "tier:", tier);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
