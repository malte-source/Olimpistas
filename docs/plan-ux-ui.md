# Plan UX/UI — Olimpistas, lo mejor de desktop y lo mejor de mobile

Fecha: 2026-10-24. Alcance: portal del socio (`/miembro`), landing, portal de comercios, portal de peñas y panel admin.
Reglas que se mantienen: no se toca el contador/globo/rampa; las campañas siguen apagadas; todo se prueba en staging y pasa a producción solo con OK; una pantalla por PR, con prueba visual a 4 anchos.

---

## 1. La idea en una frase

**Un solo sistema de diseño, dos experiencias nativas.** No es "el celular achicado" ni "el escritorio estirado":

| | Mobile (pulgar y rapidez) | Desktop (productividad y riqueza) |
|---|---|---|
| Qué optimiza | Una tarea por pantalla, alcance con el pulgar, carga instantánea, uso en la calle y en caja | Ver más a la vez, comparar, teclado, precisión, sesiones largas |
| Navegación | Barra inferior, títulos grandes que se colapsan, gestos | Barra lateral fija y plegable, buscador global (Ctrl/⌘+K), atajos |
| Detalle de algo | Hoja inferior (bottom sheet) con arrastre para cerrar | Panel lateral o maestro-detalle; diálogo centrado |
| Acciones principales | Barra fija abajo, al alcance del pulgar | Junto al contenido; atajos de teclado; menú contextual |
| Datos | Tarjetas apiladas, filtros en hoja | Tablas ordenables, filtros laterales fijos, vistas guardadas |
| Entrada | Teclado correcto por campo, autocompletar, escaneo con cámara | Arrastrar y soltar, pegar imagen, cámara web, teclado completo |
| Medio | PWA instalable, push, offline del carnet | Ventanas anchas (3 columnas ≥1600 px), impresión/PDF |

Lo que **no cambia** entre los dos: tokens (color, tipografía, espacio, movimiento), componentes, textos, accesibilidad, idioma y reglas de negocio.

---

## 2. Dónde estamos hoy (relevamiento de código, 2026-10-24)

Bueno: tokens de color y tipografía con tests que los protegen; modo claro/oscuro/automático; `prefers-reduced-motion` respetado (16 reglas); carnet offline; PWA con manifest y service worker; i18n es/en; barra lateral en escritorio; Inicio, Carnet y Beneficios ya rediseñados esta semana.

A mejorar (datos medidos):

- **Un solo archivo gigante por superficie:** `socio.js` 146 KB, `styles.css` 150 KB (1.832 líneas), `admin.html` 208 KB, `comercio.html` 67 KB. Todo se descarga aunque se use una pestaña.
- **Breakpoints desordenados:** 10 valores distintos (640, 641, 700, 900, 901, 920, 1180, 1500…). Cada componente decide por su cuenta.
- **Deuda de estilo:** 66 estilos en línea en `socio.js`, 10 `!important`, 9 tamaños de fuente en px fuera de los tokens, dos juegos de íconos (`icon()` y `OLI.ic()`).
- **Accesibilidad:** no hay enlace "saltar al contenido"; foco dentro de modales y hojas sin verificar de punta a punta; solo 46 usos de `aria-` en 15 vistas del socio; sin prueba con lector de pantalla.
- **Imágenes:** los 7,2 MB de `public/assets` son sobre todo banderas (2,1 MB) y librerías (1,4 MB). Los héroes (0,5–0,6 MB) no se usan en la landing, solo en la imagen para compartir en stories. Solo 5 de 15 `<img>` de `socio.js` con `loading="lazy"`. El peso real de la primera pantalla se mide en la Ola 0.
- **Desktop subaprovechado:** la lista de beneficios, subastas y peñas abren hojas pensadas para el celular; no hay buscador global, ni atajos, ni maestro-detalle, ni tablas con orden/filtros guardados.
- **Mobile sin "nativo":** no hay gestos, ni confirmación háptica, ni push, ni accesos directos de app, ni barra de acción fija en los flujos de plata (pujar, pagar).
- **Sin medición de experiencia real:** no sabemos LCP/INP/CLS de usuarios reales ni dónde se caen en el embudo.

---

## 3. Principios de diseño (la vara con la que se aprueba todo)

1. **Una sola acción principal por pantalla**, clara y en el lugar correcto (mobile: abajo; desktop: junto al contenido).
2. **Mostrar el estado, no obligar a adivinar**: vacío, cargando, error, éxito y "sin conexión" diseñados en cada pantalla.
3. **Rápido se siente mejor que bonito**: esqueletos, interfaz optimista, nada que bloquee la pantalla.
4. **Divulgación progresiva**: lo esencial primero, el detalle a un toque/clic.
5. **Reconocer antes que recordar**: nombres de usuario, no de sistema; íconos con texto.
6. **Deshacer antes que confirmar**: "Deshacer" en un aviso en vez de ¿Estás seguro?, salvo en plata.
7. **Accesible por defecto** (WCAG 2.2 AA): teclado, lector, contraste en los dos temas, objetivos táctiles de 44 px.
8. **Honesto**: nunca mostrar una fecha, un descuento o un estado inventado (como la antigüedad del socio).

---

## 4. El plan en olas

Esfuerzo: **S** = una tanda corta (medio día a un día), **M** = 2–4 tandas, **L** = una semana o más de tandas. Son estimaciones de orden de magnitud.

### Ola 0 — Línea base y barandas (hacerla primero, sin esto "mejorar" no se puede probar)  · M

| # | Entrega | Cómo se prueba |
|---|---|---|
| 0.1 | **Medición real (RUM):** LCP, INP, CLS y errores de JS de usuarios reales, por dispositivo y pantalla (evento propio a Plausible o `/api/vitals`) | Tablero con el p75 por pantalla |
| 0.2 | **Lighthouse CI** en 6 páginas clave (landing, registro, Inicio, Beneficios, Carnet, Subasta) en móvil y escritorio | Falla el PR si baja del presupuesto |
| 0.3 | **axe-core + Playwright** en CI: cero violaciones serias en las pantallas clave | Falla el PR si aparece una |
| 0.4 | **Capturas de regresión visual** a 375 / 768 / 1280 / 1600 px, claro y oscuro, de 10 pantallas | Diferencia > umbral = revisión manual |
| 0.5 | **Embudo medido:** registro → carnet con foto → primer beneficio usado → segundo; valida cédula; abre chat; pujó | Un solo tablero para decidir con datos |
| 0.6 | **Matriz de dispositivos:** Android de gama baja, iPhone SE, laptop 1366×768, monitor 1920, 4K | Se prueba cada ola en esos 5 |
| 0.7 | **Presupuestos:** JS inicial ≤ 120 KB comprimido, LCP ≤ 2,0 s en 4G de gama media, INP ≤ 200 ms, CLS ≤ 0,05, imagen principal ≤ 150 KB | Test que lee el tamaño de los bundles |

### Ola 1 — Cimientos: sistema de diseño v2 · L

| # | Entrega | Detalle |
|---|---|---|
| 1.1 | **Escala única** de espacio (4 pt), tipografía fluida (`clamp`), elevación, radios, capas (z-index) y **movimiento** (duraciones y curvas) como tokens | Con test que prohíbe valores sueltos, como ya pasa con los tamaños de fuente |
| 1.2 | **4 breakpoints canónicos** (600 / 900 / 1200 / 1600) en lugar de 10; los componentes usan **container queries** para adaptarse a su caja, no a la pantalla | Una tarjeta se ve bien sola en una columna, en una grilla o en un panel |
| 1.3 | **Biblioteca de componentes** con página interna `/ui-kit` (solo dev/staging): botón, chip, segmentado, tarjeta, fila de lista, estadística, pestañas, tabla, campo con validación, avatar, insignia, aviso, esqueleto, estado vacío | Una sola fuente por componente (hoy hay `card`, `bx-card`, `ih-card`, `cn2`…) |
| 1.4 | **Hoja adaptable** (`Sheet`): en mobile sube desde abajo con asa y arrastre; en desktop es panel lateral o diálogo centrado. Foco atrapado, Esc, devolver el foco | Reemplaza los modales sueltos |
| 1.5 | **Deuda:** eliminar los 66 estilos en línea, los `!important` y los px sueltos; unificar los dos sets de íconos | Con tests de guarda |
| 1.6 | **Partir los bundles:** `socio.js` en módulos por vista con carga bajo demanda; `styles.css` en núcleo + una hoja por superficie (socio, admin, comercio, landing) + CSS crítico en línea | Meta: −50 % de JS y CSS en la primera pantalla |
| 1.7 | **Imágenes:** `lazy` y tamaños explícitos en todo lo que no sea la primera pantalla; banderas y logos de comercios en SVG/WebP; sin héroes pesados en la primera carga | Presupuesto 0.7 |

### Ola 2 — Mobile de primera · L

**Navegación y estructura**
- 2.1 Encabezado con título grande que se colapsa al bajar; restaurar el scroll al volver; gesto atrás coherente; enlaces profundos a cada vista.
- 2.2 Barra inferior con insignias vivas (subasta por pagar, beneficio nuevo, mensaje del chat). Cinco destinos, nunca más.

**Alcance del pulgar**
- 2.3 **Barra de acción fija abajo** en los flujos con plata: pujar, pagar un lote, comprar membresía, validar cédula. La acción principal siempre a un pulgar.
- 2.4 Todos los objetivos táctiles de 44–48 px (auditoría automática) y 8 px de separación.
- 2.5 Hojas inferiores con arrastre para cerrar en lugar de ventanas centradas.

**Formularios sin fricción**
- 2.6 Teclado correcto por campo (`inputmode`, `autocomplete`, `enterkeyhint`), teclado numérico y máscara para cédula, validación en línea (al salir del campo), error con cómo arreglarlo.
- 2.7 **Registro en 2 pasos** y alternativa sin contraseña (código por correo o por WhatsApp) — *decisión del usuario, ver sección 6*.

**Rapidez percibida**
- 2.8 Esqueletos en todas las pantallas, **interfaz optimista** (puja, "me gusta", copiar), precarga de la pestaña probable, `content-visibility` en listas largas.
- 2.9 Pantallas pesadas (mapa, globo) cargan solo cuando se piden.

**Sentirse app**
- 2.10 **PWA completa:** acceso directo "Carnet" y "Beneficios" en el ícono, mensaje de instalar en el momento justo (después de la primera validación o canje, no al entrar), carcasa offline de las pestañas, compartir hacia Olimpistas.
- 2.11 **Notificaciones push** (con permiso explícito y a medida): te superaron en una subasta, vence tu plazo de pago, beneficio nuevo de tu ciudad, partido hoy. Ver sección 6.
- 2.12 Pantalla del carnet: fondo claro fijo, **Wake Lock** (la pantalla no se apaga en caja), QR grande, brillo recomendado, el código a la vista.
- 2.13 Gestos y hápticos discretos: tirar para actualizar, deslizar entre segmentos, vibración corta al canjear o pujar. Todo con alternativa visible.

**Pantallas a rehacer en esta ola** (una por PR, en este orden): Subastas y detalle (puja), Partidos, Puntos, Perfil y foto, Peñas, Descubrir, Registro y bienvenida, Checkout de membresía.

### Ola 3 — Desktop de primera · L

**Estructura**
- 3.1 **Barra lateral plegable** (ícono + texto / solo ícono) que recuerda su estado; secciones agrupadas; en tablet (768–1100 px) pasa a **riel de íconos** en vez de barra inferior.
- 3.2 **Buscador global (Ctrl/⌘+K):** ir a una pantalla, buscar un comercio o beneficio, una subasta, una peña, una acción ("mostrar mi QR", "hablar con una persona"). Atajos de teclado (`g` + letra) y hoja de ayuda con `?`.
- 3.3 **Grilla de 12 columnas** con ancho de contenido máximo y 3 columnas a partir de 1600 px; nunca estirar texto a más de 75 caracteres.

**Maestro–detalle y densidad**
- 3.4 **Beneficios, Subastas y Peñas:** lista a la izquierda, detalle fijo a la derecha (no una hoja que tapa todo); flechas del teclado para recorrer; filtros en una columna lateral fija.
- 3.5 Vista previa al pasar el mouse (hover) en tarjetas; estados de foco muy visibles; descripciones emergentes (tooltips) accesibles.

**Entrada de datos**
- 3.6 **Foto del carnet:** arrastrar y soltar, pegar desde el portapapeles, **cámara web** con recorte guiado y consejos ("de frente, buena luz").
- 3.7 Diálogos centrados y paneles laterales en vez de hojas inferiores.

**Admin y Comercios (escritorio es su casa)**
- 3.8 **Tablas de verdad:** encabezado fijo, ordenar, filtrar, elegir columnas, **vistas guardadas**, acciones en lote, edición en la fila, exportar CSV, navegación por teclado.
- 3.9 **Tableros** con gráficos accesibles (con tabla equivalente), comparación contra período anterior, alertas.
- 3.10 **Caja del comercio:** modo escáner con la cámara (web o celular), campo de código siempre enfocado, resultado grande y claro (verde/rojo con texto y sonido), historial del día en tabla.
- 3.11 **Centro de notificaciones** en el panel; bitácora de cambios visible.

**Salida**
- 3.12 Carnet imprimible / PDF; cartel de peña (ya existe) con más plantillas.

### Ola 4 — Excelencia transversal · L

| Área | Entrega |
|---|---|
| **Accesibilidad (WCAG 2.2 AA)** | Enlace "saltar al contenido"; puntos de referencia (landmarks) en todas las páginas; gestión de foco en hojas, diálogos y cambios de vista (anunciar la nueva pantalla); regiones `aria-live` para avisos; contraste verificado por test en los **dos temas** (cada par de tokens); texto al 200 %; `prefers-contrast` y `forced-colors`; recorrido solo con teclado; **prueba con VoiceOver y TalkBack** en los 5 flujos centrales |
| **Idioma y formato** | Español (Paraguay) revisado por una persona del club; inglés completo; plurales correctos; guaraníes y dólares con formato local; fechas con la zona de Paraguay. *Opción: guaraní en los flujos clave (decisión del usuario).* |
| **Rendimiento** | Presupuestos de la Ola 0 como puertas de CI; caché `stale-while-revalidate` para recursos versionados; `preconnect`; fuentes locales; auditoría de terceros (Pixel, GA) cargados tarde y sin bloquear |
| **Estados y confianza** | Vacío con salida, error con recuperación, éxito con próximo paso, deshacer en vez de confirmar, avisos coherentes (una sola voz y posición), página de estado, ayuda contextual |
| **Tema** | Paridad oscuro/claro auditada pantalla por pantalla; sin colores sueltos |
| **Calidad de diseño** | Lista de verificación de diseño en cada PR (estados, 4 anchos, 2 temas, teclado, lector); definición de "terminado" |

### Ola 5 — Mejora continua con datos · M (permanente)

- Experimentos A/B en el héroe de la landing y en el registro (con límite de muestra y sin tocar lo que ya funciona).
- Micro-encuesta de una pregunta después de canjear ("¿cómo estuvo?") y valoración 👍/👎 en el chat.
- Revisión mensual del tablero: embudo, vitals, errores, soporte (qué pregunta la gente → qué pantalla falla).

---

## 5. Orden recomendado (impacto ÷ esfuerzo)

**Tanda A — victorias rápidas (1–2 semanas de tandas):**
1. Enlace "saltar al contenido" + landmarks + foco en hojas/modales (Ola 4, lo más barato y más serio).
2. Unificar breakpoints y objetivos táctiles de 44 px (1.2, 2.4).
3. Teclados correctos y máscara de cédula; validación en línea (2.6).
4. Buscador global Ctrl/⌘+K y atajos (3.2).
5. Maestro–detalle en Beneficios para desktop (3.4, primera pantalla).
6. Barra fija de acción en pujar y pagar (2.3).
7. Medición real y Lighthouse CI (0.1, 0.2).

**Tanda B — cimientos:** Ola 0 completa + Ola 1 (sistema, hoja adaptable, partir bundles, imágenes).

**Tanda C — mobile y desktop en paralelo, pantalla por pantalla:** Olas 2 y 3, empezando por **Subastas** (es donde hay plata y urgencia) y **Beneficios en desktop**.

**Tanda D — Admin y Comercios en escritorio** (Ola 3.8–3.11), con la caja del comercio primero (es lo que se usa todos los días).

**Siempre:** Ola 4 y 5 corren de fondo, una mejora por PR.

---

## 6. Decisiones que necesito de vos

| Decisión | Mi recomendación |
|---|---|
| ¿Registro sin contraseña (código por correo o WhatsApp)? | Sí, como **alternativa** (no reemplaza la contraseña). Mejora mucho en celular. Cuesta mensajes de WhatsApp. |
| ¿Notificaciones push? | Sí, con permiso explícito y solo 4 tipos (subasta, plazo de pago, beneficio de tu ciudad, partido). Android y escritorio sin problema; en iPhone solo con la app instalada. |
| ¿Guaraní en los flujos clave? | Valorarlo: genera cercanía, pero pide traducción revisada por hablantes. Propongo empezar con Inicio, Carnet y Beneficios. |
| ¿Rediseñar Admin completo o por módulos? | Por módulos, empezando por Socios y Comercios (donde más se trabaja). |
| ¿Apps en las tiendas? | Después de la PWA completa y las notificaciones; la decisión sigue abierta (ver nota previa). |
| Imágenes: ¿recomprimir? | **Resuelto:** el usuario dijo que sí, pero al medir los héroes no pesan en la landing (no se usan); no hay nada que ganar ahí. Se recomprime lo que aparezca como pesado en la medición real. |

---

## 6 bis. Decisiones tomadas (2026-10-24)

| Tema | Decisión del usuario | Cómo se implementa |
|---|---|---|
| Registro | Enviar un correo para validar; la cuenta queda **pendiente de validar** | Verificación de correo con enlace; cuenta usable pero marcada pendiente (sin canjes/pujas hasta validar, a definir). Sin códigos por WhatsApp por ahora |
| Notificaciones push | Sí | Web Push con permiso explícito y 4 tipos: te superaron en una subasta, vence tu plazo de pago, beneficio de tu ciudad, partido |
| Guaraní | Sí | Idioma `gn` empezando por Inicio, Carnet y Beneficios; traducción a revisar por hablantes antes de producción |
| Admin | Por módulos | Socios y Comercios primero |
| Imágenes | OK | Ver arriba: nada pesado que recomprimir en la landing |

## 6 ter. Avance

- **Tanda A (victorias rápidas) — hecha en staging:** enlace para saltar al contenido y `<main>` en las 5 superficies; foco al título al cambiar de pantalla; teclado correcto en cédula y registro; objetivos táctiles de 44 px; buscador global Ctrl/⌘+K; detalle lateral (maestro–detalle) en Beneficios para escritorio; barra de acción fija en las subastas del celular; medición real de velocidad (`/api/vitales`, resumen en `/api/admin/vitales`); Lighthouse semanal informativo.

- **Decisiones del usuario — hechas en staging:**
  - *Cuenta pendiente de validar:* el correo de verificación ya se mandaba pero no frenaba nada. Ahora las cuentas nuevas quedan **pendientes de validar**: aviso fijo con "Reenviar" y, hasta confirmar, no pueden pujar, pagar, comprar una membresía ni validar la cédula de socio. Las cuentas anteriores ven el aviso pero no se bloquean (migración 0016, `verif_exigida`). Si no hay proveedor de correo, no se exige nada.
  - *Avisos push:* Web Push con 4 tipos (te superaron en una subasta, vence tu plazo de pago, beneficio destacado en tu ciudad, aviso del club). Permiso con un toque (se ofrece tras la primera puja y en Ajustes), cada tipo se apaga por separado, máximo un aviso de beneficio/club por persona y día, suscripciones vencidas se borran solas. Migración 0017 y claves VAPID en Secret Manager.
  - *Guaraní (beta):* selector Español / English / Avañe'ẽ en Ajustes; ~60 textos de Inicio, Carnet y Beneficios traducidos y el resto cae al español (jopara). **Requiere revisión de hablantes antes de producción.**
- **Pendiente (próximas tandas):** Ola 0 completa (capturas de regresión y axe en CI, embudo), Ola 1 (sistema de diseño, partir bundles), Olas 2 y 3 pantalla por pantalla (Subastas, Admin Socios y Comercios), y el aviso "partido de hoy" automático (hoy lo manda el equipo desde `/api/admin/push/enviar`).

## 7. Cómo mediremos que mejoró

| Indicador | Hoy | Meta |
|---|---|---|
| LCP (p75, 4G gama media) | sin medir | ≤ 2,0 s |
| INP (p75) | sin medir | ≤ 200 ms |
| CLS (p75) | sin medir | ≤ 0,05 |
| JS en la primera pantalla | ~240 KB sin comprimir (common + socio + i18n) | ≤ 120 KB comprimido |
| Violaciones de accesibilidad serias (axe) | sin medir | 0 |
| Objetivos táctiles < 44 px | sin auditar | 0 en pantallas clave |
| Registro completado (de quien empieza) | sin medir | +15 % relativo |
| Carnet con foto | sin medir | +20 % relativo |
| Usuarios que canjean un 2.º beneficio | sin medir | +10 % relativo |
| Chat: resuelto sin persona | sin medir | ≥ 60 % |
| Tiempo para pujar o pagar un lote | sin medir | −30 % |

Las metas "relativas" se fijan en cuanto exista la línea base de la Ola 0.

---

## 8. Cómo trabajamos cada pieza (para que sea seguro)

1. Una pantalla por PR, con capturas a 375 / 768 / 1280 / 1600 en claro y oscuro.
2. Tests que protegen cada regla de diseño (tokens, objetivos táctiles, foco, textos en es/en).
3. Staging primero; producción solo con tu OK; sin migraciones salvo que se avise antes.
4. Nada que cambie el contador, el globo ni la rampa; ningún dato inventado.
5. Cada ola cierra con un informe corto: qué cambió, qué se midió, qué sigue.
