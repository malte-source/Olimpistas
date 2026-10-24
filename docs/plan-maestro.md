# Plan maestro de mejora — Olimpistas, todas las instancias

*2026-10-24. Sale de cuatro auditorías de solo lectura (datos y cruces, panel administrativo, experiencia del miembro, portales de peñas y comercios con sus comunicaciones) y complementa a `docs/plan-ux-ui.md`, que cubre el sistema de diseño, mobile y desktop. Lo que ese plan ya resuelve no se repite acá.*

## 1. La idea en una frase

**Una persona, un estado, un lenguaje.** Hoy Olimpistas tiene mucho adentro (carnet, niveles, red de beneficios, peñas, subastas, puntos, atención con IA, panel, portales), pero cada parte cuenta la historia a su manera: la app del socio, el panel, el portal de la peña y el del comercio no comparten el mismo estado de la persona, ni las mismas palabras, ni los mismos datos. El plan consiste en que todas las instancias lean lo mismo, hablen igual y se avisen entre sí.

Tres consecuencias prácticas:
1. **Una sola verdad por persona:** en qué nivel está, por qué, desde cuándo, y qué le falta para volver o subir.
2. **Cada rol ve lo que necesita para decidir**, sin buscar en cinco pantallas: el miembro su ahorro y su siguiente paso; la peña su gente; el comercio sus ventas atribuidas; el equipo su cola de pendientes; la gerencia sus indicadores.
3. **Ninguna acción importante queda sin aviso:** cada cambio de estado (canje, mora, vuelta a Socio, oferta aprobada o rechazada, peña verificada) llega a quien corresponde.

## 2. Cómo se conecta hoy (mapa de entidades)

```
                       ┌────────────┐  cédula   ┌──────────────┐   API Tuti (en vivo)
   registro / peña ──▶ │   socios   │◀────────▶ │ socios_club  │◀── barrido 120/h + revisión de mora y baja
   (referido_por,      └─────┬──────┘ (sin FK)  └──────────────┘
    pena_id)                 │
   ┌───────────┬─────────────┼──────────────┬──────────────┬───────────────┐
   ▼           ▼             ▼              ▼              ▼               ▼
membresías   canjes ◀── beneficios ◀── comercios      pedidos_pago      puntos_movimientos
(historial) (tier_slug,  (3 ejes de     (acceso propio) (membresía,       (libro; saldo = SUM)
             monto,       activación)                    entrada, lote)
             ahorro)                                          │
   ▲                                                          ▼
   │                       peñas ── pena_usuarios        subastas / pujas
   └─ pena_miembros (padrón oficial, estado_cuota manual)     atención (conversaciones, mensajes)
                                                              campañas / envíos / push / correos
```

Lo que más importa de este mapa: **hay tres fuentes de "mora"** (`pena_miembros.estado_cuota` cargado a mano, `socios.club_estado` y `socios_club.tuti_estado` de la API) y **dos padrones superpuestos** (`padron_olimpia` y `socios_club`). Se cruzan por cédula normalizada, sin claves foráneas.

## 3. Qué datos tenemos y qué datos deberíamos tener

| Para quién | Hoy ya tenemos | Falta y habilita decisiones |
|---|---|---|
| **Administración** | Ficha 360 por socio, tabla paginada con filtros, estado en el club, línea de tiempo, auditoría de acciones | **Historial** de cambios (nivel, peña, estado del club, fecha de socio) con valor anterior y nuevo; motivo de baja estructurado; fechas de vencimiento y renovación reales |
| **Gerencia** | Altas, ingresos de 7 y 30 días, subastas sin pagar, pasivo de puntos, embudo (stock), mapa | **Mora y bajas como indicadores**, tiempo en mora y recupero, ingresos por período con comparación, ahorro entregado total, canjes totales, cohortes de alta y retención, ciclo de vida (nuevo, activo, dormido, perdido), LTV |
| **Comercial / red de beneficios** | Canjes y ahorro del mes por comercio, mix por nivel, ticket promedio, último canje | Ranking de comercios, **comercios dormidos**, mes contra mes, ofertas por vencer, **ventas atribuidas y hinchas nuevos por comercio**, retención (canjes recurrentes), cuota por comercio y nivel |
| **Peñas** | Miembros, vinculados, altas, socios y Plus, saldo del fondo (apagado) | Salud de la peña (padrón contra estado en el club, con foto semanal), altas por mes, atribución de canjes a la peña, historial de cambios de peña |
| **Marketing** | Campañas con filtros, conversión a Plus y Junior | **Fuente de adquisición** (utm, canal, campaña de origen), conversión a Socio, calidad de referidos (cuántos validan o pagan) |

Cruces que hoy **no se pueden hacer**, y qué los habilita:

| Cruce | Qué falta |
|---|---|
| Peña × mora | Vista `pena_salud` que una `pena_miembros` con el estado del club por cédula, más foto semanal con fecha |
| Socio × antigüedad × uso | Vista `socio_resumen` (nivel, antigüedad, canjes de 30 días, primer canje, última actividad, puntos, peña, estado del club) |
| Embudo registro → validación → primer canje | Tabla de **eventos del socio** con fecha (registro, correo verificado, foto, cédula validada, primer canje, primer pago) |
| Comercio × nivel × ciudad | `pena_id`, `ciudad_id` y antigüedad en `canjes` al momento del canje, e índice por fecha |
| Mora en el tiempo | **Historial del estado del club** (desde, hasta, deuda). Hoy cada consulta pisa la anterior |
| Campaña × resultado real | Medir conversión a Socio, no solo a Plus y Junior |

## 4. Diagnóstico por frente

### 4.1 Experiencia del miembro
- **Dos registros distintos** (onboarding y modal de la landing): el primero no manda el idioma y el paso final no dice "confirmá tu correo" (la explicación está en un bloque cerrado).
- **Bloqueos que se descubren al tocar:** con el correo pendiente, el botón Pujar se ve activo y el motivo llega como aviso de 2,6 segundos, sin botón de reenviar y siempre en español.
- **Un socio pausado por mora se ve como un no socio:** le dice "Asociate en el portal", el mismo texto que al visitante. Falta que la pantalla le hable como a alguien que **ya es socio y debe regularizar**. Tampoco hay aviso al volver al nivel.
- **Una pieza única de "estado de tu cuenta" no existe:** hoy son banners excluyentes (correo, subasta por pagar, mora) y no hay una página "Mi membresía".
- **Carnet sin red:** abrir la app en frío sin conexión corta con "No pudimos abrir tu cuenta"; el respaldo existe pero nunca se alcanza, y el service worker devuelve la landing.
- **Visitante:** no ve ni un comercio real hasta registrarse; el aspiracional vive adentro de la app.
- **Junior y padres:** no existe ninguna pantalla para ellos (tutor, consentimiento, regalo de cumpleaños, migración al cumplir años).
- **Léxico:** hincha, olimpista, miembro y socio se mezclan; los nombres de nivel están duplicados tres veces en el código; "Member since" aparece dos veces en inglés; el banner de invitación dice "Plus" donde la tarjeta dice "Socio".
- **Accesibilidad:** elementos clicables que no son botones ni enlaces, etiquetas de formulario sin asociar, estado de la puja sin anuncio para lectores de pantalla, el detalle de la subasta se redibuja cada 3,5 s y pierde el foco.

### 4.2 Administración, gerencia y comercial (panel)
- **Contenido es un cajón de sastre:** subastas, sorteos, encuestas, comercios y peñas en un selector; comercios aparece dos veces.
- **No hay cola unificada de pendientes:** pagos, validaciones, ofertas por aprobar, peñas por verificar, canjes de puntos y de fondo, subastas sin pagar y conversaciones con una persona están en seis lugares. Los contadores del tablero no son enlaces.
- **Tablas desparejas:** las de socios y pagos filtran, ordenan y exportan; ofertas, peñas, puntos, premios, canjes y subastas son listas sin nada de eso.
- **Falta lo que cada rol necesita:** tablero gerencial (mora, bajas, ingresos con comparación, ahorro entregado), tablero comercial (ranking, dormidos, mes contra mes), operaciones (una cola).
- **Hay funciones sin pantalla:** aviso push del partido, perfiles de mora y validación, vitales.
- **Tareas manuales repetitivas:** activar nivel en pagos sin match, aprobar ofertas de a una, dar acceso a comercios con contraseña a mano, extender subastas.
- **Seguridad de lectura:** finanzas, soporte y lectura conservan lectura abierta por API aunque el menú los limite. *(Se cerró hoy la fuga de nombre y correo de pagadores a la CD y a comercial.)*

### 4.3 Portales de peñas y de comercios
- **Peña:** el dueño no puede listar ni exportar sus miembros, ni recuperar o cambiar la contraseña, ni avisar a quienes faltan del padrón; no ve su evolución. Los miembros no tienen portal ni avisos.
- **Comercio:** no puede anular un canje mal cargado ni ver días anteriores en pantalla; no ve ventas atribuidas ni hinchas nuevos; no hay recuperación de contraseña, ni PIN por cajero (el canje queda a nombre del comercio); sin red, un error genérico; el aviso de rechazo de una oferta no existe.
- **Riesgos:** el código fijo del socio no se consume al canjear (una captura sirve siempre); el límite de intentos es por IP y un local con varias cajas se bloquea entre sí; las contraseñas iniciales de comercios están en un archivo en claro en la raíz del repo (`accesos-comercios.csv`, fuera de git).
- **Alta de comercio:** a mano, sin correo de bienvenida ni enlace de un solo uso (las peñas sí lo tienen).

### 4.4 Comunicaciones
Existen unos 30 tipos de correo con diseño coherente. Faltan los que sostienen la confianza:
**canje exitoso** (la prueba de valor del producto), oferta rechazada, bienvenida al comercio, solicitud de peña recibida y peña rechazada o pausada, **aviso de mora antes de pausar** y **"volviste al nivel Socio"**, vencimiento de ofertas, aviso post-vencimiento de Plus, invitación a quienes faltan en el padrón de una peña. El correo de "peña verificada" todavía promete el fondo, que está apagado.

### 4.5 Datos y modelo
Dos "es socio" sin historial; cédula normalizada con una expresión repetida en ocho lugares (*corregida hoy: en una plantilla etiquetada `'\D'` llegaba a Postgres como `'D'`*); estados como texto sin restricciones; tres campos de ciudad y dos de país; tres ejes de activación para una misma oferta; diferencias entre el almacenamiento real y el de pruebas (altas y exclusión de cuentas de prueba); `gasto_total` denormalizado que puede desfasarse.

## 5. El plan, en frentes y olas

Cada ola es entregable por sí sola, se prueba en staging y pasa a producción con tu OK. Esfuerzo: **S** (días), **M** (1–2 semanas), **L** (más).

### Ola A — Confianza y coherencia (primero: es barato y evita daño) · S/M
| # | Qué | Frente |
|---|---|---|
| A1 | **Estado de tu cuenta** como pieza única y persistente (correo, socio al día, pausado por mora, baja, Plus) con **una** acción siguiente; el socio pausado se ve como "ya sos socio, regularizá" | Miembro |
| A2 | **Post-registro:** "confirmá tu correo" visible, con Reenviar y Cambiar correo; siguiente paso al volver del enlace; mandar el idioma desde el onboarding | Miembro |
| A3 | Acciones bloqueadas **con su motivo en el mismo lugar** (Pujar, Pagar, Validar), no un aviso que se va; errores por código y traducidos | Miembro |
| A4 | **Glosario y diccionario único de niveles:** definir hincha, olimpista, miembro y socio; unificar los textos de nivel; arreglar el banner "Plus" vs "Socio" y el contador de niveles de la landing | Todos |
| A5 | **Canje exitoso:** pantalla "ahorraste ₲ X" al socio y aviso (push o correo); resumen diario al comercio | Miembro / Comercio |
| A6 | **Correos que faltan:** oferta rechazada, bienvenida al comercio (con enlace de un solo uso), solicitud de peña recibida, peña rechazada o pausada, aviso previo de mora, "volviste al nivel Socio"; corregir la promesa del fondo | Comunicaciones |
| A7 | **Portales:** recuperar y cambiar contraseña de peña y comercio; **código fijo del socio** con uso único; límite de intentos por usuario además de por IP | Portales / Seguridad |
| A8 | **Seguridad de lectura:** poner finanzas, soporte y lectura como roles restringidos o declarar la lectura abierta; sacar de la raíz del repo el archivo de accesos de comercios | Seguridad |
| A9 | Accesibilidad de interactivos: botones y enlaces reales, `label for`, anuncio del estado de la puja, no redibujar los botones en el sondeo | Miembro |

### Ola B — Datos que habilitan decidir · M
| # | Qué | Habilita |
|---|---|---|
| B1 | **Historial del estado del club** (desde, hasta, deuda), escrito por el barrido y por la revisión de mora | Mora, tiempo en mora, recupero, churn |
| B2 | **Eventos del socio** con fecha (registro, correo, foto, cédula validada, primer canje, primer pago, puja, referido) | Embudo por cohorte, "tiempo hasta el primer canje" |
| B3 | Vistas **`socio_resumen`** y **`pena_salud`** (esta con foto semanal) | Socio × antigüedad × uso; peña × mora |
| B4 | **Fuente de adquisición** al registrarse (utm, canal, campaña, peña, referido) | Costo y calidad por canal |
| B5 | **Historial de membresías** (cancelada, vencida, fin real, motivo estructurado, quién) y **auditoría de cambios** (entidad, campo, antes, después, por, cuándo) | Retención, renovación, LTV, trazabilidad |
| B6 | `canjes` con peña, ciudad y antigüedad del socio al momento; índices por fecha y por nivel | Comercio × nivel × ciudad × peña |
| B7 | Cédula normalizada **una vez** (columna generada con índice) en las cuatro tablas; restricciones de estado; alinear el almacenamiento de pruebas con el real | Cruces confiables |

### Ola C — Administrar fácil: panel por rol · M/L
| # | Qué |
|---|---|
| C1 | **Bandeja de pendientes unificada** con contadores clicables en el tablero y en el menú, acciones en el lugar y en lote |
| C2 | **Tablero gerencial** separado del técnico: mora y bajas, ingresos con comparación, conversión, ahorro entregado, canjes totales, peñas activas y dormidas |
| C3 | **Tablero comercial:** ranking de comercios, dormidos (30 días sin canjes), mes contra mes, ofertas por vencer, ventas atribuidas |
| C4 | **Partir "Contenido"** en áreas propias (Comercios y ofertas, Subastas y sorteos, Peñas, Puntos); sacar el selector y el duplicado |
| C5 | **Componente de tabla único** (filtros por columna, orden accesible, paginación, CSV) llevado a ofertas, peñas, premios, subastas, canjes y auditoría |
| C6 | **Aprobar y entregar en lote** (ofertas, peñas, canjes) y **autoconciliación** de pagos sin match por cédula o correo |
| C7 | Pantalla para lo que ya existe en el servidor (aviso push del partido, perfiles de mora y validación) y un menú de herramientas solo del owner para las acciones de desarrollo |
| C8 | Vistas guardadas en la cuenta del admin (hoy en el navegador); alertas de pendientes envejecidos |

### Ola D — Portales que dan valor a quien los usa · M/L
| # | Qué |
|---|---|
| D1 | **Peña:** exportar miembros y altas (CSV), "faltan vincular" sin datos sensibles, altas por mes, resumen de mora con solo conteo, **invitación dirigida** a quienes faltan del padrón, subusuarios (tesorero) |
| D2 | **Comercio:** **anulación de canje** con motivo y límite de tiempo, historial por día y por beneficio, **ventas atribuidas e hinchas nuevos** contra lo que paga, PIN por cajero, aviso claro sin red |
| D3 | **Miembro de peña:** una vista simple de su peña (compañeros, ranking, avisos), cambio de peña con control |
| D4 | **Alta de comercio en autoservicio guiado** con enlace de un solo uso y checklist de primeros pasos |

### Ola E — Experiencia que enamora · L
| # | Qué |
|---|---|
| E1 | **Carnet sin red de verdad:** si falla la sesión abrir el carnet guardado, el service worker sirve `/miembro`, con fecha de guardado y el código que acepta el comercio |
| E2 | **Visitante:** seis comercios reales con logo y descuento en la landing; ver beneficios sin sesión |
| E3 | **Socio al día:** mostrar el valor del estatus ("ahorraste ₲ X siendo socio"); **"Mis canjes"** y estado de entrega de premios |
| E4 | **Navegación:** reemplazar "Partidos" (vacío) por Descubrir o Mi peña; subir Perfil a un lugar visible |
| E5 | **Cuenta Junior y de padres:** tutor, consentimiento, regalo de cumpleaños, migración al cumplir años |
| E6 | Lo ya previsto en `plan-ux-ui.md` (sistema de diseño v2, mobile y desktop de primera, mejora continua con datos) |

### Ola F — Calidad continua · S/M
CI con **regresión visual y accesibilidad (axe)** sobre las vistas clave; presupuestos de rendimiento como puerta; foto→almacenamiento de archivos y tests de integración pendientes de la auditoría profunda.

## 6. Orden recomendado

1. **Ola A** completa (impacto alto, esfuerzo bajo: confianza, coherencia y seguridad).
2. **B1, B2 y B4 ya, aunque no se vean:** cada día sin historial es información que no se recupera (cuándo entró en mora, cuánto duró, de dónde vino cada alta).
3. **C1 + C2** (la cola de pendientes y el tablero gerencial) en paralelo con **D2** (anulación y ventas atribuidas del comercio: es lo que hace renovar a un comercio).
4. Resto de B, C, D; después E y F de forma continua.

## 7. Cómo mediremos que mejoró

| Qué | Indicador | Meta inicial |
|---|---|---|
| Activación | % que confirma el correo en 24 h; % que valida cédula; días hasta el primer canje | Línea base en B2, luego +20 % |
| Socio | % al día; mora recuperada en 30 días; tiempo medio en mora | Línea base en B1 |
| Valor | Canjes por socio activo por mes; ahorro entregado por nivel | Línea base |
| Comercios | % con canje en los últimos 30 días; ranking; ofertas por vencer | Menos de 20 % dormidos |
| Peñas | Altas por mes; % del padrón con cuenta; peñas dormidas | Línea base en B3 |
| Equipo | Pendientes envejecidos (más de 48 h); tiempo de primera respuesta | Cero sin dueño |
| Calidad | Nota de la IA (me sirvió / no me sirvió); incidencias de accesibilidad | Más de 80 % me sirvió |

## 8. Decisiones que necesito de vos

1. **Vocabulario:** ¿cómo llamamos a cada cosa? Propuesta: **Olimpista** = toda persona con cuenta; **Socio** = nivel del club (al día); **Hincha** solo como tono de marca, nunca como dato; **Miembro desde** = alta en Olimpistas.
2. **Aviso previo de mora:** ¿cuántos días antes de pausar el nivel? (hoy se pausa apenas el club informa la mora).
3. **Comercios:** ¿anulación de canje la decide el comercio (con límite de tiempo) o siempre pasa por el club?
4. **Datos de adquisición:** ¿empezamos a guardar utm y canal de cada alta?
5. **Junior:** ¿se sigue vendiendo? Define si la Ola E5 se construye o se retira el nivel.
6. **Roles:** ¿finanzas, soporte y lectura pasan a ver solo lo de su área?

## 9. Hecho hoy a raíz de las auditorías

- `/admin/resumen` ya no entrega nombre y correo de pagadores a la CD ni al rol comercial.
- Cédulas con puntos o guiones cruzan bien con la base del club (el `'\D'` de las consultas llegaba como `'D'`; hoy sin cuentas afectadas).
- El correo de acceso de peña ya no dice "enviado" si falló o fue simulado.
- Subir a un nivel gratis ya no llama a una función inexistente.
- Chat de atención: "Me sirvió / No me sirvió" y su conteo en el panel (insumo del indicador de calidad de la IA).
