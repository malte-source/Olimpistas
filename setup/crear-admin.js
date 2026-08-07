"use strict";
// Crea un usuario del panel admin. La contraseña va por ENV (no en el comando, para no filtrarla).
// Uso:
//   OLIMPISTAS_DATABASE_URL=... ADMIN_PASS='ClaveFuerte' node setup/crear-admin.js <usuario> <rol> [nombre...]
//   roles: owner | finanzas | marketing | soporte | lectura
const { crearAdminUsuario, ROLES } = require("../lib/admin-auth");
(async () => {
  const [usuario, rol, ...nombre] = process.argv.slice(2);
  const password = process.env.ADMIN_PASS;
  if (!usuario || !rol) { console.error("Uso: ADMIN_PASS='...' node setup/crear-admin.js <usuario> <rol> [nombre]\nroles: " + ROLES.join(" | ")); process.exit(1); }
  if (!password) { console.error("Falta ADMIN_PASS en el entorno (la contraseña, mín 8)."); process.exit(1); }
  const u = await crearAdminUsuario({ usuario, rol, password, nombre: nombre.join(" ") });
  console.log("OK: usuario creado → " + u.usuario + " (" + u.rol + ")");
  process.exit(0);
})().catch((e) => { console.error("ERROR: " + e.message); process.exit(1); });
