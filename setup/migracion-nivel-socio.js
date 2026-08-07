"use strict";
// Corrección del lanzamiento: los socios REALES del club recibieron "Plus" (premium) o
// "Junior" (kids) por edad. Ahora existe el nivel "socio" (superior a Plus, otorgado).
// Este script sube a "socio" SOLO a los socios del club — identificados por el marcador
// pago_ref LIKE 'socio:%' que puso /perfil/validar-socio. NO toca a quien PAGÓ Plus/Junior
// (pago_ref = metrepay / id de pedido / admin-manual). Es idempotente.
//
// Uso (previsualiza, no cambia nada):   OLIMPISTAS_DATABASE_URL=... node setup/migracion-nivel-socio.js
// Uso (aplica de verdad):               OLIMPISTAS_DATABASE_URL=... APLICAR=1 node setup/migracion-nivel-socio.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  // A migrar: membresías activas de socios del club (pago_ref 'socio:%') que aún figuran
  // como premium o kids. Los que pagaron NO entran (su pago_ref no empieza con 'socio:').
  const [{ n: aMigrar }] = await sql`
    SELECT COUNT(*)::int AS n FROM membresias
    WHERE estado = 'activa' AND tier_slug IN ('premium','kids') AND pago_ref LIKE 'socio:%'`;
  const [{ n: yaSocio }] = await sql`
    SELECT COUNT(*)::int AS n FROM membresias WHERE estado = 'activa' AND tier_slug = 'socio'`;
  // Salvaguarda: contamos cuántos premium/kids son PAGADOS (no deben tocarse) para dar visibilidad.
  const [{ n: pagados }] = await sql`
    SELECT COUNT(*)::int AS n FROM membresias
    WHERE estado = 'activa' AND tier_slug IN ('premium','kids')
      AND (pago_ref IS NULL OR pago_ref NOT LIKE 'socio:%')`;

  console.log("── Nivel SOCIO — corrección de lanzamiento ──");
  console.log("Socios del club a subir a 'socio':", aMigrar);
  console.log("Ya en 'socio' (no se tocan):      ", yaSocio);
  console.log("Premium/Junior PAGADOS (intactos):", pagados);

  if (process.env.APLICAR !== "1") {
    console.log("\n[PREVIEW] No se cambió nada. Para aplicar: APLICAR=1 node setup/migracion-nivel-socio.js");
    await sql.end();
    process.exit(0);
  }

  const filas = await sql`
    UPDATE membresias SET tier_slug = 'socio'
    WHERE estado = 'activa' AND tier_slug IN ('premium','kids') AND pago_ref LIKE 'socio:%'
    RETURNING id`;
  console.log("\n[APLICADO] Membresías subidas a 'socio':", filas.length);
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
