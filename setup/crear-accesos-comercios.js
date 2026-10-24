"use strict";
// Crea el acceso al panel de validación (/comercio) de los comercios que todavía no tienen usuario, con una contraseña inicial
// al azar, y deja un CSV para entregárselas. Por defecto solo muestra qué haría; con --aplicar lo hace.
//
//   ADMIN_KEY=... node setup/crear-accesos-comercios.js https://www.olimpistas.com --salida accesos-comercios.csv            (simula)
//   ADMIN_KEY=... node setup/crear-accesos-comercios.js https://www.olimpistas.com --salida accesos-comercios.csv --aplicar
//
// El CSV tiene contraseñas: no se sube al repo (está en .git/info/exclude) y se entrega por un canal privado. Cada comercio puede
// cambiar la suya después. Si un comercio ya tiene usuario no se toca (no se pisa ninguna contraseña).

const fs = require("fs");
const crypto = require("crypto");

const args = process.argv.slice(2);
const base = (args[0] || "").replace(/\/+$/, "");
const opt = (k) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : null; };
const aplicar = args.includes("--aplicar");
const salida = opt("salida") || "accesos-comercios.csv";
const clave = process.env.ADMIN_KEY || "";

if (!/^https?:\/\//.test(base) || !clave) { console.error("Uso: ADMIN_KEY=... node setup/crear-accesos-comercios.js <url> [--salida archivo.csv] [--aplicar]"); process.exit(1); }

const slug = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
// Sin letras que se confunden (0/O, 1/l/I): se dicta o se copia sin errores.
const ALFA = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const clavealeatoria = (n = 12) => Array.from(crypto.randomBytes(n), (b) => ALFA[b % ALFA.length]).join("");
const csv = (v) => '"' + String(v).replace(/"/g, '""') + '"';

async function api(ruta, opts = {}) {
  const r = await fetch(base + "/api" + ruta, { ...opts, headers: { "x-admin-key": clave, "Content-Type": "application/json", ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && j.error) || "HTTP " + r.status);
  return j;
}

(async () => {
  const { items } = await api("/admin/comercios");
  const usados = new Set(items.map((c) => c.usuario).filter(Boolean));
  const filas = [["comercio", "usuario", "contrasena_inicial", "panel"]];
  let n = 0;
  for (const c of items.filter((x) => x.estado === "activo" && !x.usuario)) {
    let usuario = slug(c.nombre), k = 2;
    while (usados.has(usuario)) usuario = slug(c.nombre) + "-" + k++;
    usados.add(usuario);
    const password = clavealeatoria();
    if (aplicar) await api("/admin/comercios/" + encodeURIComponent(c.id) + "/acceso", { method: "POST", body: JSON.stringify({ usuario, password }) });
    filas.push([c.nombre, usuario, password, base + "/comercio"]);
    n++;
    console.log((aplicar ? "creado  " : "crearía ") + usuario);
  }
  if (aplicar && n) {
    fs.writeFileSync(salida, "﻿" + filas.map((f) => f.map(csv).join(",")).join("\r\n") + "\r\n", { mode: 0o600 });
    console.log(`\n${n} accesos creados. Contraseñas en ${salida} (no se sube al repo).`);
  } else console.log(`\n${n} comercios sin acceso${aplicar ? "" : " (simulación: no se creó nada)"}.`);
})().catch((e) => { console.error("Falló: " + e.message); process.exit(1); });
