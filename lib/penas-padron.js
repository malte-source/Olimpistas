"use strict";
// Padrón de las peñas: del informe del club (Excel) a peñas verificadas con su listado de miembros.
// Este módulo no lee el Excel (eso lo hace setup/importar-penas.js): recibe las filas ya leídas y las aplica contra el store.
//   fila = [peña, nombre y apellido, n° de socio, cédula, estado]

const norm = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const limpiar = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const digitos = (s) => String(s == null ? "" : s).replace(/\D/g, "");

function estadoCuota(txt) {
  const t = norm(txt);
  if (t === "al dia") return "al_dia";
  if (t === "en mora") return "en_mora";
  return "sin_dato";
}

// Datos de la peña que se deducen del nombre sin adivinar (el club puede corregirlos después desde el admin).
const DATOS_POR_NOMBRE = {
  "hernandarias (poh)": { ciudad: "Hernandarias", pais_iso: "PY" },
  "franjeados minga guazu": { ciudad: "Minga Guazú", pais_iso: "PY" },
  "libertadores de america (ny)": { ciudad: "Nueva York", pais_iso: "US" },
};

// Arma el plan: peñas en el orden en que aparecen, miembros con su orden global (la primera peña manda si alguien está en dos).
function armarPlan(filas) {
  const penas = new Map();
  const out = { penas: [], filas: 0, sinCedula: 0, descartadas: 0, repetidasEnOtraPena: 0, cedulaCompartida: 0 };
  const primera = new Map();
  filas.forEach((f, i) => {
    const nombrePena = limpiar(f[0]);
    const nombre = limpiar(f[1]);
    if (!nombrePena || !nombre) { out.descartadas++; return; }
    out.filas++;
    let cedula = digitos(f[3]);
    if (cedula.length < 5 || cedula.length > 12) cedula = "";
    if (!cedula) out.sinCedula++;
    const k = norm(nombrePena);
    if (!penas.has(k)) { const p = { nombre: nombrePena, ...(DATOS_POR_NOMBRE[k] || {}), miembros: [] }; penas.set(k, p); out.penas.push(p); }
    const p = penas.get(k);
    if (cedula) {
      const igual = p.miembros.find((m) => m.cedula === cedula);
      if (igual) {
        // Misma cédula dentro de la misma peña: si es el mismo nombre es una fila repetida; si es otra persona, el informe la cargó con una cédula
        // que ya tenía otro miembro (error de origen): se conserva la persona pero SIN cédula, para no vincularla con la cuenta equivocada.
        if (norm(igual.nombre) === norm(nombre)) { out.descartadas++; return; }
        out.cedulaCompartida++; cedula = ""; out.sinCedula++;
      } else if (primera.has(cedula) && primera.get(cedula) !== k) out.repetidasEnOtraPena++;
      else primera.set(cedula, k);
    }
    if (!cedula && p.miembros.some((m) => !m.cedula && norm(m.nombre) === norm(nombre))) { out.descartadas++; return; }
    p.miembros.push({ cedula, nombre, nro_socio: digitos(f[2]), estado_cuota: estadoCuota(f[4]), orden: i });
  });
  return out;
}

// Aplica el plan: crea (o reutiliza por nombre) cada peña como VERIFICADA y carga su padrón; después vincula con las cuentas y asigna peña.
async function aplicarPlan(store, plan, { fuente = "informe del club" } = {}) {
  const existentes = new Map((await store.listPenas()).map((p) => [norm(p.nombre), p]));
  const out = { penas_creadas: 0, penas_existentes: 0, miembros_nuevos: 0, miembros_actualizados: 0 };
  for (const p of plan.penas) {
    let pena = existentes.get(norm(p.nombre));
    if (pena) out.penas_existentes++;
    else {
      pena = await store.crearPena({ nombre: p.nombre, ciudad: p.ciudad || "", pais_iso: p.pais_iso || "PY", presidente: "", contacto: "" });
      out.penas_creadas++;
    }
    if (pena.estado !== "verificada") await store.updatePena(pena.id, { estado: "verificada" });
    const r = await store.importarMiembrosPena(pena.id, p.miembros, fuente);
    out.miembros_nuevos += r.nuevos; out.miembros_actualizados += r.actualizados;
  }
  const s = await store.sincronizarMiembrosPena();
  return { ...out, vinculados: s.vinculados, invitados: s.invitados };
}

module.exports = { armarPlan, aplicarPlan, estadoCuota, norm };
