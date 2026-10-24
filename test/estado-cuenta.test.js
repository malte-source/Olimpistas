"use strict";
// "Estado de tu cuenta": una sola pieza con la subasta por pagar, el correo y el nivel Socio, en las palabras de quien ya es socio.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const j = leer("public", "js", "socio.js"), i = leer("public", "js", "i18n.js"), c = leer("public", "css", "styles.css");
const cuerpo = j.slice(j.indexOf("async function renderBannerSocio()"), j.indexOf("// La persona cuenta desde qué año es socia"));

test("los avisos se muestran juntos: la subasta por pagar ya no tapa al correo ni al estado del club", () => {
  assert.ok(/partes\.push\(`<div class="socio-banner socio-banner-pago">/.test(cuerpo));
  assert.ok(!/\breturn;\s*\n\s*\}\s*\n\s*\} catch/.test(cuerpo.slice(0, cuerpo.indexOf("// 2. Correo"))), "la alerta de subasta no corta la función");
  assert.ok(/host\.innerHTML = partes\.join\(""\)/.test(cuerpo));
  assert.ok(/\} else if \(!sinCorreo\) \{/.test(cuerpo), "la invitación a validar la cédula solo si no hay un aviso de correo");
});

test("quien está en pausa por el club ve 'seguís siendo socio', cómo volver y 'ya pagué'; al volver se le avisa una vez", () => {
  assert.ok(/if \(pausadoClub\(\)\) \{/.test(cuerpo) && /guardarVisto\(sv\.club_estado\)/.test(cuerpo));
  assert.ok(/esSocioValidado\(\) && \(visto === "mora" \|\| visto === "baja"\)/.test(cuerpo), "el aviso de vuelta depende de haber visto la pausa antes");
  assert.ok(/id="vueltaX"/.test(cuerpo) && /guardarVisto\(""\)/.test(cuerpo), "se cierra y no vuelve");
  assert.ok(/localStorage\.removeItem\("oli_club_estado_visto"\)/.test(j), "tras 'Ya pagué' (que ya festeja) no se repite el aviso de vuelta");
  assert.ok(/id="clubPague"/.test(cuerpo) && /revisarClub\(\)/.test(cuerpo));
});

test("a quien está en pausa no se le ofrece 'Asociate': los botones y rótulos del aspiracional cambian según el estado", () => {
  assert.ok(!/T\("asp_asociate"\)|T\("asp_lbl"\)|T\("asp_ya_soy"\)/.test(j.replace(/const ctaAsociate[^\n]*\n|const lblAsp[^\n]*\n|const yaSoyTxt[^\n]*\n/g, "")), "todo pasa por los tres ayudantes");
  assert.ok(/const ctaAsociate = \(\) => T\(pausadoClub\(\) \? "asp_regulariza" : "asp_asociate"\)/.test(j));
  assert.ok(/const lblAsp = \(\) => T\(pausadoClub\(\) \? "asp_lbl_pausa" : "asp_lbl"\)/.test(j));
  assert.ok(/const yaSoyTxt = \(\) => T\(pausadoClub\(\) \? "asp_ya_pague" : "asp_ya_soy"\)/.test(j));
});

test("textos del estado de cuenta en español e inglés, y estilos del aviso", () => {
  for (const k of ["asp_regulariza", "asp_lbl_pausa", "asp_ya_pague", "ec_mora_h", "ec_mora_p", "ec_baja_h", "ec_baja_p", "ec_portal_mora", "ec_portal_baja", "ec_ya_baja", "ec_vuelta_h", "ec_vuelta_p", "ec_ver"])
    assert.strictEqual((i.match(new RegExp("\\b" + k + ":", "g")) || []).length, 2, k + " en es y en");
  assert.ok(/ec_mora_h: "Tu cuota del club está pendiente\{monto\}"/.test(i));
  for (const s of [".estado-cuenta .ec-p", ".estado-cuenta .ec-acc", ".socio-banner-vuelta"]) assert.ok(c.includes(s), s);
});
