"use strict";
// Autorización por nivel de membresía (escalonado). Núcleo del gateo de contenido/subastas/preventas.
const { test } = require("node:test");
const assert = require("node:assert");
const access = require("../lib/access");

const mem = (slug) => ({ tier_slug: slug });

test("público (sin membresía) no alcanza ningún nivel (−1 < 0)", () => {
  assert.equal(access.puedeAcceder(null, "olimpista"), false); // olimpista = nivel 0, público = -1
  assert.equal(access.puedeAcceder(null, "premium"), false);
});

test("olimpista accede a lo olimpista pero NO a premium", () => {
  assert.equal(access.puedeAcceder(mem("olimpista"), "olimpista"), true);
  assert.equal(access.puedeAcceder(mem("olimpista"), "kids"), false);
  assert.equal(access.puedeAcceder(mem("olimpista"), "premium"), false);
});

test("premium (Plus) desbloquea escalonadamente kids y olimpista", () => {
  assert.equal(access.puedeAcceder(mem("premium"), "olimpista"), true);
  assert.equal(access.puedeAcceder(mem("premium"), "kids"), true);
  assert.equal(access.puedeAcceder(mem("premium"), "premium"), true);
});

test("socio está por encima de todo", () => {
  for (const req of ["olimpista", "kids", "premium", "socio"]) {
    assert.equal(access.puedeAcceder(mem("socio"), req), true);
  }
  assert.equal(access.puedeAcceder(mem("premium"), "socio"), false); // Plus NO alcanza a Socio
});

test("nivelRequerido de un slug desconocido es 0 (no rompe)", () => {
  assert.equal(access.nivelRequerido("no-existe"), 0);
});
