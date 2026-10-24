# Análisis a fondo de la base de socios del club (`Socios_Antiguedad_Calculada.xlsx`)

Fecha: 2026-10-24. Solo cifras agregadas: este documento no contiene datos personales y el archivo original no está en el repositorio ni se subió a ningún servicio. Nada de la base de Olimpistas se modificó (el cruce fue de solo lectura y solo contó).

## 1. Qué es el archivo

- Una hoja ("Socios"), **117.263 filas** y 15 columnas. Por los nombres ("Nombre SN", "Número de identificación fiscal", "Grupo") parece una exportación del sistema administrativo del club (socios de negocio), no de Tuti.
- Columnas: nombre, tipo de identificación, número de identificación, correo, teléfono 1, grupo, número de socio, fecha de ingreso, activo (Y/N), fecha de nacimiento, año del primer registro de cuota, antigüedad base (años), meses pagados por cuotas, antigüedad total (años), antigüedad en texto ("N años y M meses").
- **113.961 cédulas utilizables distintas.** Nuestro padrón actual tiene 11.670: el archivo es **9,8 veces más grande**. Las 11.670 del padrón están dentro (11.640 se encuentran; 30 no).

## 2. Lo más importante: "Activo" NO significa "al día"

- 114.478 filas dicen Activo = Y, pero **82.963 filas (71 %) tienen 0 meses de cuotas pagadas**.
- De las 1.350 cuentas de Olimpistas marcadas como socio del club, 1.347 figuran en el archivo y **las 1.347 dicen Activo = Y**. En cambio la API en vivo (Tuti) había marcado unas 424 de esas cuentas como bajas el 2026-10-05. Es decir: el archivo no sirve para decidir quién está al día ni quién se dio de baja.
- **Regla que se mantiene:** el estado (al día / baja) lo sigue dando Tuti. Este archivo sirve para **enriquecer** (antigüedad, grupo, número de socio, reconocer adherentes), **nunca para otorgar el nivel Socio**. Por eso no corresponde cargarlo en `padron_olimpia`: ahí cualquier cédula presente se valida sola como "al día".

## 3. Grupos (plan)

| Grupo | Filas | Comentario |
|---|---|---|
| PERSONAL | 38.940 | |
| ESTADIO | 30.155 | |
| FAMILIAR | 24.765 | adherentes: 24.040 activos; 7.406 sin número propio |
| INTERIOR | 7.777 | |
| CADETE | 5.271 | |
| INFANTIL | 4.463 | |
| **General No Socio** | **2.735** | **no son socios**; 2.729 sin número de socio |
| VITALICIO | 1.580 | 1.283 sin año de primer registro de cuota (no pagan cuota) |
| EXTERIOR | 1.338 | diáspora |
| Socio Protector | 203 | |
| Campeones de América | 27 | |
| Sponsor / Hinchas Oficiales / Vendedor | 6 / 2 / 1 | no son socios |

Para el nivel Socio hay que excluir "General No Socio", "Sponsor", "Vendedor" y "Hinchas Oficiales" (2.744 filas). Inactivos (N): 2.785.

## 4. Identificación

| Caso | Filas | Qué hacer |
|---|---|---|
| Cédula numérica | 108.860 | normal |
| **RUC con guion** ("1234567-8") | 8.267 | la cédula es lo anterior al guion; si no, no coincide con la cédula que escribe la persona (hoy 8 dígitos ≠ 7) |
| Texto con otros formatos (pasaporte, etc.) | 131 | revisar |
| Cédula **corrompida a fecha** por Excel | 3 | irrecuperables sin el original |
| Sin identificación | 2 | descartar |
| Identificaciones de 1 a 4 dígitos (marcadores) | ≈ 2.400 | descartar (nuestro mínimo es 5) |

- **Repetidos:** 958 identificaciones aparecen en 2.843 filas (máximo 35 veces). Los pares típicos son FAMILIAR+FAMILIAR (161), FAMILIAR+PERSONAL (103), PERSONAL+PERSONAL (80) y FAMILIAR+INFANTIL (77). **772 de los 958 tienen nombres distintos**: se usa la cédula del titular para varios miembros de la familia. Para cruzar por cédula hay que decidir cuál fila manda (propuesta: activa, de socio real y con número propio).
- **Número de socio:** 101.798 distintos; 2.281 se repiten en 7.149 filas (el 89 % dentro del mismo grupo: un plan familiar comparte número). Rango 40 a 135.785. 10.000 filas no tienen número.

## 5. Fecha de ingreso (la base de "Socio desde")

| Calidad | Filas | % |
|---|---|---|
| Creíble | 73.566 | 62,7 % |
| **Día de carga masiva** (≥ 300 altas el mismo día) | 30.619 | 26,1 % |
| Sin fecha | 12.043 | 10,3 % |
| Fecha cero (1899-12-31, valor vacío de Excel) | 1.024 | 0,9 % |
| Anterior a 1950 | 10 | |
| Futura (2026-11-05) | 1 | |

- Hay **43 días con 300 o más altas el mismo día** (31.643 filas, el 27 %). Los más fuertes: 7 al 11 de febrero de 2020 (≈ 10.000 filas), 27 al 31 de diciembre de 2018 y 2 de enero de 2019 (≈ 6.700), 15 de enero de 2018 (1.257) y 15 de febrero de 2011 (873).
- Concentración por año: 2011 (16.448, repartidas en 313 días, pico febrero a abril), 2018 (12.912, diciembre 7.510), 2019 (13.660, enero 5.948) y 2020 (16.995, febrero 13.041).
- **No se puede saber desde acá si son altas reales** (campañas de afiliación de temporada) **o cargas de migración del sistema.** Hay que preguntarle al club. Si son migración, la fecha de esas filas no es la antigüedad real.
- Entre las 1.347 cuentas ya socias en Olimpistas: **1.091 tienen fecha creíble (81 %)**, 235 caen en día de carga masiva (17 %), 15 no tienen fecha y 6 tienen la fecha cero. Solo 2 tienen un ingreso al club posterior a su registro en la app.

## 6. Las columnas de antigüedad calculada

- **Fórmula descifrada (100 % consistente):** `Antigüedad Base = máximo(0, año del primer registro de cuota − año de ingreso)` y `Antigüedad Total = Base + meses pagados / 12`.
- Es una **antigüedad "pagada"**, no la fecha desde que es socio: el registro de cuotas arranca de forma masiva en **2017** (2017: 4.635, 2018: 10.718, 2019: 15.670, 2020: 24.037…), así que casi toda la antigüedad sale de los meses de cuota pagados desde entonces. Quien tuvo períodos sin pagar queda subestimado.
- **Problemas:** 1.396 filas tienen la fecha cero y dan una base absurda de 117 a 126 años (518 con más de 90 años); la Base es 0 en 53.289 filas; 15.612 filas no tienen año de primer registro (FAMILIAR 11.279, No Socio 2.495, VITALICIO 1.283, Protector 202); 1.044 filas tienen el año de ingreso posterior al del primer registro de cuota.
- De los 111.779 socios activos de socio real, **98.692 tienen antigüedad total calculada** y solo **53.617** llegan a 1 año o más.

## 7. Contacto

- Con correo 70.233 (59,9 %): 70.118 con formato válido, 115 inválidos. Con teléfono 70.570 (60,2 %). **Sin correo ni teléfono: 22.548.**
- Correos distintos 67.476; **2.284 correos se comparten entre 2 o más filas** (5.041 filas, máximo 54 filas con el mismo correo): sirve para familia pero **no para identificar a una persona**.
- Teléfonos: los largos son mezcla (9 dígitos sin el 0 inicial, 12 con 595, 6 de línea baja, 1 dígito de marcador); solo 28.327 se reconocen como móviles de Paraguay; hace falta normalizar a +595.
- Dominios: gmail.com 51.316, hotmail.com 13.501, icloud.com 971.

## 8. Nacimiento y nombres

- Fecha de nacimiento utilizable en 107.891 filas; 289 vienen como texto, 31 son la fecha cero y hay 60 imposibles (hasta el año 9158). Edades: 0 a 12 años 7.143, 13 a 17 años 3.691, 18 a 29 años 22.157, 30 a 44 años 49.587, 45 a 59 años 17.926, 60 o más 7.387.
- Nombres: casi todo en MAYÚSCULAS (115.863), 391 con formato "APELLIDO, NOMBRE", 445 con espacios de más, 6 con un número en lugar del nombre. 2.933 nombres aparecen repetidos con identificaciones distintas (posibles personas duplicadas).

## 9. Cruce con lo que ya tenemos (solo conteos)

- Cuentas de Olimpistas: 19.667; 3.908 con cédula; 1.350 marcadas como socio del club. Cédulas repetidas entre cuentas: 0.
- **Socios ya reconocidos:** 1.347 de 1.350 están en el archivo (734 PERSONAL, 233 ESTADIO, 216 FAMILIAR, 81 VITALICIO, 45 INTERIOR, 23 CADETE, 9 INFANTIL, 6 EXTERIOR); 3 no figuran.
- **Cuentas con cédula que todavía no son socias: 2.558**; **1.642** figuran en el archivo como activas y de socio real (PERSONAL 642, ESTADIO 466, FAMILIAR 316, INTERIOR 117, CADETE 63, INFANTIL 17, EXTERIOR 16, VITALICIO 5). Candidatas a reconocer, pero **hay que confirmar el estado con Tuti**, y las 316 FAMILIAR son adherentes que Tuti no devuelve.
- **Cuentas sin cédula: 15.759**; **3.883** tienen un correo que aparece en el archivo (24,6 %). Es una coincidencia débil (un correo puede ser de una familia): sirve para **sugerir** que carguen su cédula, no para reconocer.
- El archivo trae **24.040 adherentes FAMILIAR activos**, justo los que la API en vivo no devuelve (da 404). Sirve para reconocerlos, pero **falta saber de qué titular dependen y si ese titular está al día**.

## 10. Qué propongo hacer (nada de esto está hecho)

1. **Cargar el archivo en una tabla de referencia aparte** (`socios_club`), no en el padrón: cédula normalizada (RUC sin guion), grupo, número de socio, fecha de ingreso con su calidad, años base y meses pagados, activo según el sistema del club. Se usa solo para enriquecer; el nivel Socio sigue dependiendo de Tuti.
2. **Reglas de limpieza al importar:** quitar el dígito del RUC, descartar identificaciones de menos de 5 dígitos y las corruptas, excluir los grupos "No Socio", resolver repetidos (activa, socio real, con número propio), fecha cero y futuras a vacío, nombres en minúscula con inicial mayúscula, teléfonos a formato internacional.
3. **Qué mostrar como "Socio desde"** (a decidir, ver abajo).
4. **Reconocimiento de cuentas:** pasar por Tuti las 1.642 cuentas candidatas (de a lotes, respetando su límite) y sugerir a las 3.883 con coincidencia de correo que carguen su cédula.
5. **Adherentes:** si el club puede agregar el número del titular y el estado de cuotas, se habilitan sin pasos manuales.

## 11. Decisiones y preguntas

**Para vos:**
- ¿Qué se muestra como "Socio desde"? (a) solo la fecha de ingreso creíble (el 81 % de los socios que ya están en la app); (b) además, para los días de carga masiva, solo el año si el club confirma que son altas reales; (c) además la antigüedad pagada del club ("N años de socio activo").
- ¿Autorizás cargar la base completa (117 mil personas, incluidos unos 9.700 menores en CADETE e INFANTIL) en la base de Olimpistas con acceso restringido? Los correos y teléfonos de personas que no se registraron **no deberían usarse para campañas** sin su consentimiento y el aval escrito del club.

**Para el club:**
1. ¿Qué pasó el 7 al 11 de febrero de 2020, el 27 de diciembre de 2018 al 2 de enero de 2019 y en 2011? ¿Altas reales o migraciones?
2. ¿Qué significa "Activo"? ¿Existe una columna de cuotas al día / en mora?
3. ¿Se puede agregar el número del titular para cada adherente FAMILIAR?
4. ¿Qué representa la fecha 1899-12-31 y la fecha futura del 2026-11-05?
5. ¿Qué significan ESTADIO, INTERIOR, EXTERIOR, CADETE y "Campeones de América" para beneficios y precios?
6. ¿Podemos usar los datos de contacto y para qué fines?
