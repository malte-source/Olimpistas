"use strict";
// Permisos del panel admin por rol (can). owner todo; lectura NO escribe.
const { test } = require("node:test");
const assert = require("node:assert");
const adminAuth = require("../lib/admin-auth");

test("owner puede todo", () => {
  assert.equal(adminAuth.can("owner", "contenido.write"), true);
  assert.equal(adminAuth.can("owner", "usuarios"), true);
  assert.equal(adminAuth.can("owner", "cualquier.cosa"), true);
});

test("lectura NO puede escribir contenido ni gestionar usuarios", () => {
  assert.equal(adminAuth.can("lectura", "contenido.write"), false);
  assert.equal(adminAuth.can("lectura", "usuarios"), false);
});

test("rol desconocido no tiene permisos", () => {
  assert.equal(adminAuth.can("hacker", "contenido.write"), false);
  assert.equal(adminAuth.can(undefined, "contenido.write"), false);
});

test("los roles definidos existen", () => {
  assert.ok(adminAuth.ROLES.includes("owner"));
  assert.ok(adminAuth.ROLES.includes("lectura"));
});
