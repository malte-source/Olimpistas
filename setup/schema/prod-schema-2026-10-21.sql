--
-- PostgreSQL database dump
--

\restrict WBUa6SMHwvSSgXT1xqDHSVbBtLfnbASoGzCgbp3HL21GPMV7GSmbdm5GVQMMJG8

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: acciones_admin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acciones_admin (
    id text NOT NULL,
    accion text NOT NULL,
    target_id text,
    detalle text DEFAULT ''::text,
    por text DEFAULT 'admin'::text,
    creado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: actualizaciones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.actualizaciones (
    id text NOT NULL,
    socio_id text,
    tipo text NOT NULL,
    nombre text DEFAULT ''::text,
    apellido text DEFAULT ''::text,
    email text DEFAULT ''::text,
    cedula text DEFAULT ''::text,
    pais text DEFAULT ''::text,
    ciudad text DEFAULT ''::text,
    fecha_nacimiento date,
    tiene_selfie boolean DEFAULT false NOT NULL,
    tier_pretendido text DEFAULT ''::text,
    match_padron_id text,
    estado text DEFAULT 'pendiente'::text NOT NULL,
    notas text DEFAULT ''::text,
    verificado_por text,
    verificado_en timestamp with time zone,
    creado timestamp with time zone DEFAULT now() NOT NULL,
    actualizado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_sesiones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_sesiones (
    token text NOT NULL,
    admin_id text NOT NULL,
    rol text NOT NULL,
    expira timestamp with time zone NOT NULL,
    creado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_usuarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_usuarios (
    id text NOT NULL,
    usuario text NOT NULL,
    nombre text DEFAULT ''::text,
    password_hash text NOT NULL,
    rol text DEFAULT 'lectura'::text NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    creado timestamp with time zone DEFAULT now() NOT NULL,
    ultimo_acceso timestamp with time zone
);


--
-- Name: beneficios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.beneficios (
    id text NOT NULL,
    comercio_id text NOT NULL,
    titulo text NOT NULL,
    descripcion text DEFAULT ''::text,
    tipo text DEFAULT 'descuento'::text,
    valor text DEFAULT ''::text,
    niveles text DEFAULT 'todos'::text NOT NULL,
    pct numeric,
    ahorro_estimado integer,
    vigencia_desde date,
    vigencia_hasta date,
    limite_dias integer,
    activo boolean DEFAULT true NOT NULL,
    creado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: campana_envios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campana_envios (
    id text NOT NULL,
    campana_id text NOT NULL,
    socio_id text,
    email text DEFAULT ''::text,
    tier_pretendido text DEFAULT ''::text,
    estado_inicial text DEFAULT ''::text,
    enviado_ok boolean DEFAULT false NOT NULL,
    convertido boolean DEFAULT false NOT NULL,
    convertido_en timestamp with time zone,
    creado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: campanas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campanas (
    id text NOT NULL,
    nombre text NOT NULL,
    tipo text DEFAULT ''::text,
    total_enviados integer DEFAULT 0 NOT NULL,
    creada timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: canjes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canjes (
    id text NOT NULL,
    beneficio_id text NOT NULL,
    socio_id text,
    comercio_id text,
    validado_por text DEFAULT ''::text,
    monto integer,
    ahorro integer,
    creado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: comercio_sesiones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comercio_sesiones (
    token text NOT NULL,
    comercio_id text NOT NULL,
    expira timestamp with time zone NOT NULL,
    creado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: comercios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comercios (
    id text NOT NULL,
    nombre text NOT NULL,
    rubro text DEFAULT ''::text,
    logo text DEFAULT ''::text,
    direccion text DEFAULT ''::text,
    ciudad text DEFAULT ''::text,
    contacto text DEFAULT ''::text,
    usuario text,
    password_hash text,
    estado text DEFAULT 'activo'::text NOT NULL,
    creado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contenido; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contenido (
    id text NOT NULL,
    titulo text NOT NULL,
    tipo text DEFAULT 'video'::text NOT NULL,
    tier_min text DEFAULT 'olimpista'::text NOT NULL,
    duracion text,
    thumb text,
    descripcion text,
    publicado date
);


--
-- Name: demo_agregado; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demo_agregado (
    pais_iso text NOT NULL,
    ciudad text DEFAULT ''::text NOT NULL,
    lat double precision,
    lng double precision,
    count integer DEFAULT 0 NOT NULL
);


--
-- Name: email_eventos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_eventos (
    id text NOT NULL,
    tipo text NOT NULL,
    email text DEFAULT ''::text,
    message_id text DEFAULT ''::text,
    asunto text DEFAULT ''::text,
    creado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: encuestas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.encuestas (
    id text NOT NULL,
    titulo text DEFAULT ''::text NOT NULL,
    pregunta text DEFAULT ''::text NOT NULL,
    opciones text DEFAULT '[]'::text NOT NULL,
    tipo text DEFAULT 'opcion'::text NOT NULL,
    nivel_min text DEFAULT 'olimpista'::text NOT NULL,
    estado text DEFAULT 'borrador'::text NOT NULL,
    creado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: membresias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.membresias (
    id text NOT NULL,
    socio_id text NOT NULL,
    tier_slug text NOT NULL,
    ciclo text DEFAULT 'anio'::text NOT NULL,
    estado text DEFAULT 'activa'::text NOT NULL,
    inicio timestamp with time zone DEFAULT now() NOT NULL,
    fin timestamp with time zone,
    pago_ref text
);


--
-- Name: notificaciones_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notificaciones_log (
    clave text NOT NULL,
    creado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: padron_olimpia; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.padron_olimpia (
    id text NOT NULL,
    cedula text DEFAULT ''::text,
    email text DEFAULT ''::text,
    nombre text DEFAULT ''::text,
    telefono text DEFAULT ''::text,
    nro_socio text DEFAULT ''::text,
    reclamado boolean DEFAULT false NOT NULL,
    socio_id text,
    creado timestamp with time zone DEFAULT now() NOT NULL,
    apellido text DEFAULT ''::text
);


--
-- Name: participaciones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.participaciones (
    id text NOT NULL,
    sorteo_id text NOT NULL,
    socio_id text NOT NULL,
    creado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pedidos_pago; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pedidos_pago (
    id text NOT NULL,
    socio_id text,
    concepto text NOT NULL,
    monto integer NOT NULL,
    moneda text DEFAULT 'PYG'::text NOT NULL,
    tier_slug text,
    ciclo text DEFAULT 'anio'::text NOT NULL,
    estado text DEFAULT 'pendiente'::text NOT NULL,
    ref_externa text,
    creado timestamp with time zone DEFAULT now() NOT NULL,
    reserva_id text,
    subasta_id text
);


--
-- Name: preventas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.preventas (
    id text NOT NULL,
    evento text NOT NULL,
    fecha date,
    sede text,
    abre date,
    tier_min text DEFAULT 'olimpista'::text NOT NULL,
    precio_desde integer,
    imagen text,
    stock integer DEFAULT 0 NOT NULL
);


--
-- Name: pujas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pujas (
    id text NOT NULL,
    subasta_id text NOT NULL,
    socio_id text NOT NULL,
    monto integer NOT NULL,
    creado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reservas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reservas (
    id text NOT NULL,
    preventa_id text NOT NULL,
    socio_id text NOT NULL,
    cantidad integer DEFAULT 1 NOT NULL,
    creado timestamp with time zone DEFAULT now() NOT NULL,
    estado text DEFAULT 'pendiente_pago'::text NOT NULL
);


--
-- Name: respuestas_encuesta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.respuestas_encuesta (
    id text NOT NULL,
    encuesta_id text NOT NULL,
    socio_id text NOT NULL,
    opcion integer,
    texto text,
    creado timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sesiones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sesiones (
    token text NOT NULL,
    socio_id text NOT NULL,
    expira timestamp with time zone NOT NULL
);


--
-- Name: socios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.socios (
    id text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    nombre text DEFAULT ''::text,
    telefono text DEFAULT ''::text,
    whatsapp text DEFAULT ''::text,
    foto text DEFAULT ''::text,
    pais text DEFAULT ''::text,
    pais_iso text DEFAULT ''::text,
    ciudad text DEFAULT ''::text,
    lat double precision,
    lng double precision,
    creado timestamp with time zone DEFAULT now() NOT NULL,
    email_verificado boolean DEFAULT false NOT NULL,
    verif_token text,
    mostrar_exacto boolean DEFAULT false NOT NULL,
    cedula text DEFAULT ''::text,
    es_socio_olimpia boolean DEFAULT false NOT NULL,
    apellido text DEFAULT ''::text,
    fecha_nacimiento date,
    reset_token text,
    reset_token_exp timestamp with time zone,
    ref_codigo text,
    referido_por text,
    marketing_baja boolean DEFAULT false NOT NULL,
    marketing_baja_en timestamp with time zone,
    idioma text DEFAULT 'es'::text NOT NULL,
    avisos_subastas boolean DEFAULT true NOT NULL,
    avisos_sorteos boolean DEFAULT true NOT NULL,
    avisos_contenido boolean DEFAULT true NOT NULL
);


--
-- Name: sorteos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sorteos (
    id text NOT NULL,
    titulo text NOT NULL,
    descripcion text,
    tier_min text DEFAULT 'olimpista'::text NOT NULL,
    cierra date,
    imagen text,
    ganador_id text
);


--
-- Name: subastas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subastas (
    id text NOT NULL,
    titulo text NOT NULL,
    descripcion text DEFAULT ''::text,
    imagen text,
    emoji text DEFAULT '🔨'::text,
    nivel_min text DEFAULT 'premium'::text NOT NULL,
    precio_inicial integer DEFAULT 0 NOT NULL,
    incremento integer DEFAULT 50000 NOT NULL,
    puja_actual integer DEFAULT 0 NOT NULL,
    ganador_id text,
    inicia timestamp with time zone DEFAULT now() NOT NULL,
    termina timestamp with time zone,
    estado text DEFAULT 'activa'::text NOT NULL,
    notificado boolean DEFAULT false NOT NULL,
    creado timestamp with time zone DEFAULT now() NOT NULL,
    duracion_horas integer,
    slug text,
    pausada_en timestamp with time zone,
    pago_estado text
);


--
-- Name: acciones_admin acciones_admin_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acciones_admin
    ADD CONSTRAINT acciones_admin_pkey PRIMARY KEY (id);


--
-- Name: actualizaciones actualizaciones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actualizaciones
    ADD CONSTRAINT actualizaciones_pkey PRIMARY KEY (id);


--
-- Name: admin_sesiones admin_sesiones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_sesiones
    ADD CONSTRAINT admin_sesiones_pkey PRIMARY KEY (token);


--
-- Name: admin_usuarios admin_usuarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_usuarios
    ADD CONSTRAINT admin_usuarios_pkey PRIMARY KEY (id);


--
-- Name: admin_usuarios admin_usuarios_usuario_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_usuarios
    ADD CONSTRAINT admin_usuarios_usuario_key UNIQUE (usuario);


--
-- Name: beneficios beneficios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beneficios
    ADD CONSTRAINT beneficios_pkey PRIMARY KEY (id);


--
-- Name: campana_envios campana_envios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campana_envios
    ADD CONSTRAINT campana_envios_pkey PRIMARY KEY (id);


--
-- Name: campanas campanas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campanas
    ADD CONSTRAINT campanas_pkey PRIMARY KEY (id);


--
-- Name: canjes canjes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canjes
    ADD CONSTRAINT canjes_pkey PRIMARY KEY (id);


--
-- Name: comercio_sesiones comercio_sesiones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comercio_sesiones
    ADD CONSTRAINT comercio_sesiones_pkey PRIMARY KEY (token);


--
-- Name: comercios comercios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comercios
    ADD CONSTRAINT comercios_pkey PRIMARY KEY (id);


--
-- Name: contenido contenido_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contenido
    ADD CONSTRAINT contenido_pkey PRIMARY KEY (id);


--
-- Name: email_eventos email_eventos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_eventos
    ADD CONSTRAINT email_eventos_pkey PRIMARY KEY (id);


--
-- Name: encuestas encuestas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encuestas
    ADD CONSTRAINT encuestas_pkey PRIMARY KEY (id);


--
-- Name: membresias membresias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membresias
    ADD CONSTRAINT membresias_pkey PRIMARY KEY (id);


--
-- Name: notificaciones_log notificaciones_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notificaciones_log
    ADD CONSTRAINT notificaciones_log_pkey PRIMARY KEY (clave);


--
-- Name: padron_olimpia padron_olimpia_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.padron_olimpia
    ADD CONSTRAINT padron_olimpia_pkey PRIMARY KEY (id);


--
-- Name: participaciones participaciones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participaciones
    ADD CONSTRAINT participaciones_pkey PRIMARY KEY (id);


--
-- Name: participaciones participaciones_sorteo_id_socio_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participaciones
    ADD CONSTRAINT participaciones_sorteo_id_socio_id_key UNIQUE (sorteo_id, socio_id);


--
-- Name: pedidos_pago pedidos_pago_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedidos_pago
    ADD CONSTRAINT pedidos_pago_pkey PRIMARY KEY (id);


--
-- Name: preventas preventas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preventas
    ADD CONSTRAINT preventas_pkey PRIMARY KEY (id);


--
-- Name: pujas pujas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pujas
    ADD CONSTRAINT pujas_pkey PRIMARY KEY (id);


--
-- Name: reservas reservas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservas
    ADD CONSTRAINT reservas_pkey PRIMARY KEY (id);


--
-- Name: respuestas_encuesta respuestas_encuesta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.respuestas_encuesta
    ADD CONSTRAINT respuestas_encuesta_pkey PRIMARY KEY (id);


--
-- Name: sesiones sesiones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sesiones
    ADD CONSTRAINT sesiones_pkey PRIMARY KEY (token);


--
-- Name: socios socios_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.socios
    ADD CONSTRAINT socios_email_key UNIQUE (email);


--
-- Name: socios socios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.socios
    ADD CONSTRAINT socios_pkey PRIMARY KEY (id);


--
-- Name: sorteos sorteos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sorteos
    ADD CONSTRAINT sorteos_pkey PRIMARY KEY (id);


--
-- Name: subastas subastas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subastas
    ADD CONSTRAINT subastas_pkey PRIMARY KEY (id);


--
-- Name: idx_acciones_admin_creado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_acciones_admin_creado ON public.acciones_admin USING btree (creado DESC);


--
-- Name: idx_actualizaciones_estado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actualizaciones_estado ON public.actualizaciones USING btree (estado, creado DESC);


--
-- Name: idx_actualizaciones_socio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actualizaciones_socio ON public.actualizaciones USING btree (socio_id);


--
-- Name: idx_admin_sesiones_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_sesiones_admin ON public.admin_sesiones USING btree (admin_id);


--
-- Name: idx_admin_sesiones_expira; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_sesiones_expira ON public.admin_sesiones USING btree (expira);


--
-- Name: idx_beneficios_comercio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_beneficios_comercio ON public.beneficios USING btree (comercio_id);


--
-- Name: idx_campana_envios_camp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campana_envios_camp ON public.campana_envios USING btree (campana_id);


--
-- Name: idx_canjes_socio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canjes_socio ON public.canjes USING btree (socio_id, beneficio_id, creado DESC);


--
-- Name: idx_comercios_usuario; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_comercios_usuario ON public.comercios USING btree (usuario) WHERE ((usuario IS NOT NULL) AND (usuario <> ''::text));


--
-- Name: idx_email_eventos_tipo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_eventos_tipo ON public.email_eventos USING btree (tipo, creado DESC);


--
-- Name: idx_encuestas_estado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_encuestas_estado ON public.encuestas USING btree (estado);


--
-- Name: idx_membresias_socio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_membresias_socio ON public.membresias USING btree (socio_id, estado);


--
-- Name: idx_padron_cedula; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_padron_cedula ON public.padron_olimpia USING btree (cedula) WHERE (cedula <> ''::text);


--
-- Name: idx_padron_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_padron_email ON public.padron_olimpia USING btree (lower(email)) WHERE (email <> ''::text);


--
-- Name: idx_pedidos_socio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pedidos_socio ON public.pedidos_pago USING btree (socio_id);


--
-- Name: idx_pedidos_subasta; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pedidos_subasta ON public.pedidos_pago USING btree (subasta_id);


--
-- Name: idx_pujas_socio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pujas_socio ON public.pujas USING btree (socio_id);


--
-- Name: idx_pujas_subasta; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pujas_subasta ON public.pujas USING btree (subasta_id, monto DESC);


--
-- Name: idx_pujas_subasta_socio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pujas_subasta_socio ON public.pujas USING btree (subasta_id, socio_id);


--
-- Name: idx_reservas_estado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservas_estado ON public.reservas USING btree (estado);


--
-- Name: idx_resp_enc_opcion; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_resp_enc_opcion ON public.respuestas_encuesta USING btree (encuesta_id, opcion);


--
-- Name: idx_sesiones_socio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sesiones_socio ON public.sesiones USING btree (socio_id);


--
-- Name: idx_socios_cedula_norm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_socios_cedula_norm ON public.socios USING btree (regexp_replace(cedula, '[^0-9]'::text, ''::text, 'g'::text)) WHERE (cedula <> ''::text);


--
-- Name: idx_socios_cedula_unica; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_socios_cedula_unica ON public.socios USING btree (cedula) WHERE (cedula <> ''::text);


--
-- Name: idx_socios_exacto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_socios_exacto ON public.socios USING btree (mostrar_exacto) WHERE (mostrar_exacto = true);


--
-- Name: idx_socios_pais; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_socios_pais ON public.socios USING btree (pais_iso);


--
-- Name: idx_socios_ref_codigo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_socios_ref_codigo ON public.socios USING btree (ref_codigo);


--
-- Name: idx_socios_referido_por; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_socios_referido_por ON public.socios USING btree (referido_por) WHERE (referido_por IS NOT NULL);


--
-- Name: idx_socios_reset_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_socios_reset_token ON public.socios USING btree (reset_token) WHERE (reset_token IS NOT NULL);


--
-- Name: idx_subastas_estado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subastas_estado ON public.subastas USING btree (estado, termina);


--
-- Name: uq_respuesta_socio; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_respuesta_socio ON public.respuestas_encuesta USING btree (encuesta_id, socio_id);


--
-- Name: uq_subastas_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_subastas_slug ON public.subastas USING btree (slug) WHERE (slug IS NOT NULL);


--
-- Name: actualizaciones actualizaciones_socio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actualizaciones
    ADD CONSTRAINT actualizaciones_socio_id_fkey FOREIGN KEY (socio_id) REFERENCES public.socios(id) ON DELETE SET NULL;


--
-- Name: beneficios beneficios_comercio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beneficios
    ADD CONSTRAINT beneficios_comercio_id_fkey FOREIGN KEY (comercio_id) REFERENCES public.comercios(id) ON DELETE CASCADE;


--
-- Name: canjes canjes_beneficio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canjes
    ADD CONSTRAINT canjes_beneficio_id_fkey FOREIGN KEY (beneficio_id) REFERENCES public.beneficios(id) ON DELETE CASCADE;


--
-- Name: canjes canjes_socio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canjes
    ADD CONSTRAINT canjes_socio_id_fkey FOREIGN KEY (socio_id) REFERENCES public.socios(id) ON DELETE SET NULL;


--
-- Name: membresias membresias_socio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membresias
    ADD CONSTRAINT membresias_socio_id_fkey FOREIGN KEY (socio_id) REFERENCES public.socios(id) ON DELETE CASCADE;


--
-- Name: participaciones participaciones_socio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participaciones
    ADD CONSTRAINT participaciones_socio_id_fkey FOREIGN KEY (socio_id) REFERENCES public.socios(id) ON DELETE CASCADE;


--
-- Name: participaciones participaciones_sorteo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participaciones
    ADD CONSTRAINT participaciones_sorteo_id_fkey FOREIGN KEY (sorteo_id) REFERENCES public.sorteos(id) ON DELETE CASCADE;


--
-- Name: pedidos_pago pedidos_pago_socio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedidos_pago
    ADD CONSTRAINT pedidos_pago_socio_id_fkey FOREIGN KEY (socio_id) REFERENCES public.socios(id) ON DELETE SET NULL;


--
-- Name: pedidos_pago pedidos_pago_subasta_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedidos_pago
    ADD CONSTRAINT pedidos_pago_subasta_id_fkey FOREIGN KEY (subasta_id) REFERENCES public.subastas(id) ON DELETE SET NULL;


--
-- Name: pujas pujas_socio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pujas
    ADD CONSTRAINT pujas_socio_id_fkey FOREIGN KEY (socio_id) REFERENCES public.socios(id) ON DELETE CASCADE;


--
-- Name: pujas pujas_subasta_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pujas
    ADD CONSTRAINT pujas_subasta_id_fkey FOREIGN KEY (subasta_id) REFERENCES public.subastas(id) ON DELETE CASCADE;


--
-- Name: reservas reservas_preventa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservas
    ADD CONSTRAINT reservas_preventa_id_fkey FOREIGN KEY (preventa_id) REFERENCES public.preventas(id) ON DELETE CASCADE;


--
-- Name: reservas reservas_socio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservas
    ADD CONSTRAINT reservas_socio_id_fkey FOREIGN KEY (socio_id) REFERENCES public.socios(id) ON DELETE CASCADE;


--
-- Name: respuestas_encuesta respuestas_encuesta_encuesta_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.respuestas_encuesta
    ADD CONSTRAINT respuestas_encuesta_encuesta_id_fkey FOREIGN KEY (encuesta_id) REFERENCES public.encuestas(id) ON DELETE CASCADE;


--
-- Name: respuestas_encuesta respuestas_encuesta_socio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.respuestas_encuesta
    ADD CONSTRAINT respuestas_encuesta_socio_id_fkey FOREIGN KEY (socio_id) REFERENCES public.socios(id) ON DELETE CASCADE;


--
-- Name: sesiones sesiones_socio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sesiones
    ADD CONSTRAINT sesiones_socio_id_fkey FOREIGN KEY (socio_id) REFERENCES public.socios(id) ON DELETE CASCADE;


--
-- Name: sorteos sorteos_ganador_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sorteos
    ADD CONSTRAINT sorteos_ganador_id_fkey FOREIGN KEY (ganador_id) REFERENCES public.socios(id) ON DELETE SET NULL;


--
-- Name: subastas subastas_ganador_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subastas
    ADD CONSTRAINT subastas_ganador_id_fkey FOREIGN KEY (ganador_id) REFERENCES public.socios(id) ON DELETE SET NULL;


--
-- Name: contenido; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contenido ENABLE ROW LEVEL SECURITY;

--
-- Name: membresias; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.membresias ENABLE ROW LEVEL SECURITY;

--
-- Name: participaciones; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.participaciones ENABLE ROW LEVEL SECURITY;

--
-- Name: pedidos_pago; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pedidos_pago ENABLE ROW LEVEL SECURITY;

--
-- Name: preventas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.preventas ENABLE ROW LEVEL SECURITY;

--
-- Name: reservas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reservas ENABLE ROW LEVEL SECURITY;

--
-- Name: sesiones; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sesiones ENABLE ROW LEVEL SECURITY;

--
-- Name: socios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.socios ENABLE ROW LEVEL SECURITY;

--
-- Name: sorteos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sorteos ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict WBUa6SMHwvSSgXT1xqDHSVbBtLfnbASoGzCgbp3HL21GPMV7GSmbdm5GVQMMJG8

