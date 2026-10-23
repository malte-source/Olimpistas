"use strict";
// Carga los beneficios de muestra (data/beneficios-muestra.js) en la Red de Beneficios. Idempotente: si el comercio o el
// beneficio ya existen NO se tocan (así no se pisa lo que el admin haya editado) y correrlo dos veces no duplica nada.
const { BENEFICIOS_MUESTRA } = require("../data/beneficios-muestra");

const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

// actualizar: true reescribe el texto y el valor de los que ya existen (para corregir la muestra); por defecto no pisa nada.
async function cargarMuestra(store, { items = BENEFICIOS_MUESTRA, actualizar = false } = {}) {
  const out = { comercios_creados: 0, comercios_existentes: 0, beneficios_creados: 0, beneficios_existentes: 0, beneficios_actualizados: 0 };
  const comercios = new Map((await store.listComercios()).map((c) => [norm(c.nombre), c]));
  const beneficios = await store.listBeneficios();
  for (const { comercio, beneficio } of items) {
    let c = comercios.get(norm(comercio.nombre));
    if (c) out.comercios_existentes++;
    else {
      // Si la ciudad es una ciudad oficial, queda ubicado en el mapa; "Todo el país" y "Online" no tienen punto.
      const ciu = store.ciudadPorNombre ? await store.ciudadPorNombre({ nombre: comercio.ciudad, pais: "PY" }).catch(() => null) : null;
      c = await store.crearComercio({ ...comercio, estado: "activo", lat: ciu ? ciu.lat : null, lng: ciu ? ciu.lng : null });
      comercios.set(norm(comercio.nombre), c);
      out.comercios_creados++;
    }
    const previo = beneficios.find((b) => b.comercio_id === c.id && norm(b.titulo) === norm(beneficio.titulo));
    if (previo) {
      out.beneficios_existentes++;
      if (actualizar && store.updateBeneficio) {
        await store.updateBeneficio(previo.id, { descripcion: beneficio.descripcion, valor: beneficio.valor, pct: beneficio.pct, niveles: beneficio.niveles });
        out.beneficios_actualizados++;
      }
      continue;
    }
    const b = await store.crearBeneficio({ ...beneficio, comercio_id: c.id });
    beneficios.push(b);
    out.beneficios_creados++;
  }
  return out;
}

module.exports = { cargarMuestra };
