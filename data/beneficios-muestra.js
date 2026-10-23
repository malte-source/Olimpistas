"use strict";
// Beneficios de muestra de la Red de Beneficios, tomados de la "Matriz Unificada - Red de Beneficios" del club.
// Todos son EXCLUSIVOS PARA SOCIOS (niveles = "socio"): un hincha que no valida su carnet de socio los ve bloqueados.
// Todos se canjean con el carnet de Olimpistas (QR que cambia cada minuto): los comercios validan desde el panel de Olimpistas.
// Excepciones con canal propio: Petrosur (app de Petrosur) y G5 PRO (ticketeras). El estado de socio sale del padrón del club
// (Portal de Socios / Tuti): la app convive con ese portal, no lo reemplaza.
// A propósito NO se copian los datos de las empresas (RUC, representantes legales, cédulas, correos): no son para el público.
// Se cargan con lib/beneficios-muestra.js (idempotente: no duplica si se corre dos veces).

const NIVEL = "socio";

// [marca, rubro, ciudad, valor, pct, dias, sucursales, incluye, acceso, notas]
const FILAS = [
  ["Superseis", "Supermercado", "Todo el país", "10%", 10, "Todos los días del año", "Todas las sucursales de Superseis y Superseis Express a nivel nacional", "Todos los productos disponibles en las tiendas, sin excepción", "Presentá la cédula de identidad en la caja al momento de tu compra", "Exclusivo para socios al día. Tope mensual de Gs. 1.500.000."],
  ["Petrosur", "Combustible", "Todo el país", "10%", 10, "Domingos", "Todas las estaciones de servicio habilitadas a nivel nacional", "Todos los combustibles disponibles actualmente", "Instalá la nueva App de Petrosur y registrate con el número de cédula del titular", "Exclusivo para socios al día. El beneficio es a través de la nueva App de Petrosur."],
  ["G5 PRO", "Eventos", "Todo el país", "10%", 10, "Todos los días", "A través de las distintas ticketeras (según el evento)", "Todos los eventos organizados por G5 PRO", "Agregá el número de cédula del titular", "Exclusivo para socios al día. Es acumulable con otra promoción vigente."],
  ["MUAR", "Moda", "Asunción", "30%", 30, "Jueves a sábados", "Avenida Santa Teresa, Asunción (Paseo La Galería)", "Todos los productos de MUAR", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones."],
  ["Fauna Town", "Mascotas", "Asunción", "10%", 10, "Todos los días", "Shopping Mariscal López, Estación Los Jardines, Paseo La Galería, Pinedo Shopping y Paseo Cerro Alto", "Servicios de baño, peluquería y consultas veterinarias", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día."],
  ["El Lector", "Librería", "Todo el país", "10%", 10, "Todos los jueves", "Plaza Uruguaya, Centro Cultural (San Martín), Pinedo, Villamorra, Mariscal, Paseo La Galería, Mariano, Plaza Madero, Del Sol, Multiplaza, CDE (Av. del Lago y Arena Shops), Encarnación y Century Lambaré", "Todos los productos de El Lector", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día."],
  ["DHL", "Envíos", "Todo el país", "20%", 20, "Todos los días", "Casa Central, Paseo La Galería, Centro, Aeropuerto Silvio Pettirossi, San Lorenzo Shopping, Ciudad del Este y Shopping Estación Los Jardines", "Envíos de paquetes y documentos de cualquier peso", "Presentá el perfil \"Activo\" del socio titular en el Portal de Socios del club (socios.clubolimpia.com.py)", "Exclusivo para socios al día."],
  ["Columbia", "Moda", "Asunción", "15%", 15, "Lunes a jueves", "Tienda Columbia del Paseo La Galería", "Todos los productos de la tienda", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos."],
  ["American Eagle", "Moda", "Asunción", "20%", 20, "Todos los días", "Paseo La Galería (Nivel 1) y Mariscal (Bloque A, Nivel 1)", "Toda la mercadería regular", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otros beneficios."],
  ["Agrofield", "Agro", "Todo el país", "10%", 10, "Todos los días", "Casa Central, Sucursal Eusebio Ayala, Abasto Norte, Encarnación, Isla de Francia, Loma Pytã y Ciudad del Este", "Todos los productos de Agrofield", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día."],
  ["Santorini Café Bar", "Gastronomía", "Asunción", "30%", 30, "Jueves a sábados", "Estudio Santorini (Dr. Benigno Ferreira esq. RI 4 Curupayty)", "Todos los productos de Santorini Café Bar", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones ni descuentos vigentes."],
  ["Santorini", "Belleza y bienestar", "Asunción", "30%", 30, "Lunes a sábados", "Estudio Santorini (Dr. Benigno Ferreira esq. RI 4 Curupayty)", "Todos los servicios de Santorini", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones ni descuentos vigentes."],
  ["Pulsak", "Moda", "Asunción", "25%", 25, "Todos los días", "Pulsak del Paseo La Galería", "Todos los productos de Pulsak", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día."],
  ["Patrol", "Moda", "Todo el país", "20%", 20, "Todos los días", "Shopping Mariano, Shopping Pinedo, Shopping Mariscal López, Shopping Multiplaza y Tienda Aviadores del Chaco", "Todas las prendas de temporada. No incluye productos básicos ni clásicos", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos."],
  ["Otto", "Moda", "Luque", "30%", 30, "Todos los días", "Todas las tiendas de My Store (Av. Gral. José Gervasio Artigas 3609, Dr. Antonio Bestard 393 y, Rosario y Rojas Silva, en Luque)", "Todos los productos de Otto, excepto prendas y calzados deportivos", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos."],
  ["Orkin", "Servicios del hogar", "Asunción", "10%", 10, "Todos los días", "Casa Central (Avda. Choferes del Chaco 1449, Asunción)", "Servicios de fumigación, exclusivamente en casas residenciales", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día."],
  ["Mundo Fiesta", "Cotillón", "Asunción", "20%", 20, "Todos los días", "Mundo Fiesta (Paraguarí 580) y Denis Roa, en Asunción", "Todos los productos de cotillón, excepto golosinas", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos. No incluye golosinas."],
  ["Óptica Meister", "Óptica", "Fernando de la Mora", "15%", 15, "Todos los días", "Ingavi 8000 entre Cnel. Cazal y Aca Yuasa, Fernando de la Mora", "Todos los productos disponibles en la tienda, sin excepción", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos."],
  ["Global Trading", "Comercio", "Asunción", "10%", 10, "Todos los días", "Entre Santiago León y Prof. César Samaniego (nº 1755), Asunción", "Todos los productos disponibles en la tienda, sin excepción", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos."],
  ["Resinhaus", "Artesanías", "Online", "10%", 10, "Todos los días", "Tienda virtual", "Todos los productos disponibles en la tienda, sin excepción", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos."],
  ["Heaven Joyas", "Joyas", "Asunción", "15%", 15, "Todos los días", "Villamorra Shopping y Av. Mariscal López", "Joyas de acero y enchapadas en oro y plata. No incluye joyas de oro", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos."],
  ["Isiona", "Servicios", "Online", "15%", 15, "Todos los días", "Tienda virtual", "Todos los servicios disponibles, sin excepción", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos."],
  ["One2One", "Servicios", "Asunción", "15%", 15, "Todos los días", "Denis Roa 1348, Asunción", "Todos los servicios disponibles, sin excepción", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos."],
  ["Life Medical", "Salud", "Lambaré", "10% a 20%", 10, "Todos los días", "Nanawa 903 esq. 12 de Junio, Lambaré", "Servicios seleccionados", "Presentá la cédula de identidad del socio titular", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos."],
  ["Mudraa", "Belleza y bienestar", "Asunción", "30%", 30, "Lunes a viernes", "Carmen Soler 3640, Asunción", "Todos los servicios disponibles, sin excepción", "Presentá el perfil \"Activo\" del socio titular en el Portal de Socios del club (socios.clubolimpia.com.py)", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos."],
  ["Vida Estética", "Belleza y bienestar", "Asunción", "20%", 20, "Todos los días", "Av. Venezuela 573, Asunción", "Todos los servicios disponibles, sin excepción", "Presentá el perfil \"Activo\" del socio titular en el Portal de Socios del club (socios.clubolimpia.com.py)", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos."],
  ["Liberato", "Moda", "Asunción", "Hasta 25%", 15, "Con tarjeta: todos los días. Con transferencia o efectivo: lunes y martes", "Patio Garay (John F. Kennedy c/ José Asunción Flores, Asunción), Encarnación y Paseo 1811 (Fernando de la Mora)", "Colección general: 20% con tarjeta de crédito o débito y 25% con transferencia. Colección Lacoste y Tommy: 15% con tarjeta y 25% con transferencia. Todos los productos disponibles, sin excepción", "Presentá el perfil \"Activo\" del socio titular en el Portal de Socios del club (socios.clubolimpia.com.py)", "Exclusivo para socios al día. Es acumulable con las promociones vigentes del día con entidades bancarias."],
  ["Lumino Estética", "Belleza y bienestar", "Asunción", "25% + 5%", 25, "Lunes a miércoles", "América c/ Mcal. López, Asunción", "Todos los servicios disponibles, sin excepción. 25% de descuento, más 5% adicional para socios con débito automático, y 50% el día del cumpleaños del socio", "Presentá el perfil \"Activo\" del socio titular en el Portal de Socios del club (socios.clubolimpia.com.py)", "Exclusivo para socios al día. No acumulable con otras promociones o descuentos."],
];

const CANJE_CON_CARNET = "Mostrá tu carnet de Olimpistas (el QR cambia cada minuto): el comercio lo escanea y te aplica el descuento";
const CANAL_PROPIO = ["Petrosur", "G5 PRO"]; // conservan la mecánica acordada (app / ticketera)

const BENEFICIOS_MUESTRA = FILAS.map(([marca, rubro, ciudad, valor, pct, dias, sucursales, incluye, acceso, notas]) => ({
  comercio: { nombre: marca, rubro, ciudad, direccion: sucursales },
  beneficio: {
    titulo: dias,
    valor,
    pct,
    niveles: NIVEL,
    // Una línea por dato ("Etiqueta: texto"): la hoja del beneficio las muestra ordenadas.
    descripcion: `Dónde: ${sucursales}
Incluye: ${incluye}
Cómo acceder: ${CANAL_PROPIO.includes(marca) ? acceso : CANJE_CON_CARNET}
Importante: ${notas}`,
  },
}));

module.exports = { BENEFICIOS_MUESTRA, NIVEL };
