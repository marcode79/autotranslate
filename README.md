# AutoTranslate

Traductor en vivo multiusuario para reuniones, pestañas y otras fuentes capturadas desde el navegador. Incluye acceso con Google, historial persistente, medición de consumo de Gemini, cuotas mensuales y una integración opcional con Stripe.

## Arquitectura

- React + Vite en `frontend/`.
- Express + TypeScript en `backend/`.
- Supabase Auth para Google OAuth.
- Supabase/PostgreSQL para perfiles, conversaciones, segmentos, planes y consumo.
- Gemini para transcripción y traducción de audio.
- Stripe Checkout, Customer Portal y webhooks para membresías.

El audio se procesa por fragmentos y no se almacena. Sólo se guardan la transcripción, traducción y métricas de uso.

## Configuración de Supabase

1. Crea un proyecto en Supabase.
2. Abre SQL Editor y ejecuta `backend/supabase/migrations/001_multiuser.sql`.
3. En Authentication > Providers habilita Google y configura las credenciales OAuth de Google Cloud.
4. Agrega `http://localhost:5173` como Redirect URL durante desarrollo.
5. Copia `frontend/.env.example` a `frontend/.env.local` y completa URL y anon key.
6. Copia `backend/.env.example` a `backend/.env` y completa URL, anon key y service role key.

La `SUPABASE_SERVICE_ROLE_KEY` sólo debe existir en el backend.

## Proyecto y clave de Gemini

Crea un proyecto de Google Cloud exclusivo para AutoTranslate y genera allí una clave restringida a Gemini API. Colócala en `backend/.env` como `GEMINI_API_KEY`. Esto separa los reportes y cuotas del otro proyecto.

Los precios usados para estimar costo son configurables mediante:

- `GEMINI_AUDIO_INPUT_USD_PER_MILLION`
- `GEMINI_TEXT_INPUT_USD_PER_MILLION`
- `GEMINI_OUTPUT_USD_PER_MILLION`

Revísalos cuando Google cambie las tarifas. Cada evento conserva un snapshot de los precios aplicados.

## Stripe (opcional)

1. Crea un producto y precio recurrente.
2. Configura `STRIPE_SECRET_KEY` y `STRIPE_PRICE_ID_PRO`.
3. Registra el webhook `POST /api/billing/webhook` para eventos `customer.subscription.*`.
4. Configura el secreto de firma como `STRIPE_WEBHOOK_SECRET`.
5. Ajusta los planes y límites en la tabla `plans`.

Sin estas variables, autenticación, historial y consumo funcionan; únicamente los botones de pago responderán que Stripe no está configurado.

## Desarrollo

```bash
npm install --workspaces
npm run dev
```

Frontend: `http://localhost:5173`
Backend: `http://localhost:4000`

## Verificación

```bash
npm run build
npm audit
```

## Límites

El backend verifica dos límites del plan antes de cada llamada:

- Minutos de audio del periodo.
- Costo estimado acumulado de Gemini.

También registra tokens de audio, texto, salida y pensamiento a partir de `usageMetadata`. Para alto volumen, el siguiente endurecimiento recomendado es mover la reserva y contabilización de cuota a una función PostgreSQL transaccional, evitando sobreconsumo marginal por solicitudes simultáneas.

## Fase 2: cuotas transaccionales y administración

Después de la migración inicial, ejecuta una sola vez en Supabase SQL Editor:

- `backend/supabase/migrations/002_usage_admin.sql`

Esta migración añade `usage_periods` y las funciones atómicas `reserve_usage`, `finalize_usage` y `release_usage`. No elimina conversaciones ni consumo existente.

Para habilitar el menú administrativo en la cuenta propietaria, ejecuta reemplazando el correo:

```sql
update public.profiles
set role = 'admin', updated_at = now()
where email = 'tu-correo@gmail.com';
```

Cierra sesión y vuelve a entrar. El menú **Administración** permitirá revisar usuarios, conversaciones, minutos, costo estimado y cambiar planes manualmente durante el piloto.

El historial permite buscar por título, renombrar, descargar como TXT y eliminar conversaciones. La primera transcripción asigna automáticamente un título a las conversaciones nuevas.

## Fase 3: endurecimiento para piloto y producción

Ejecuta después de `002_usage_admin.sql`:

- `backend/supabase/migrations/003_production_hardening.sql`

Añade recuperación de reservas interrumpidas, auditoría administrativa, idempotencia de webhooks Stripe y el reporte `daily_usage`. No elimina datos existentes.

Controles operativos disponibles:

- `API_RATE_LIMIT`: solicitudes por IP cada 15 minutos (600 por defecto).
- `TRANSLATION_RATE_LIMIT`: fragmentos por IP por minuto (30 por defecto).
- `X-Request-Id` en cada respuesta y logs JSON estructurados.
- Exportación completa de datos personales desde **Mi plan**.
- Eliminación permanente de cuenta con confirmación textual.
- Edición de minutos y precio de planes desde **Administración**.
- Reporte de minutos diarios de los últimos 14 días.

Para varias instancias del backend, sustituye el almacén en memoria de `express-rate-limit` por Redis antes de escalar horizontalmente. En una sola instancia, la configuración actual es suficiente para el piloto.

## Fase 4: acceso controlado

Ejecuta después de `003_production_hardening.sql`:

- `backend/supabase/migrations/004_controlled_access.sql`

La migración conserva aprobadas todas las cuentas existentes. A partir de ese momento, cada cuenta nueva queda en `pending` y no puede crear conversaciones, traducir ni iniciar Checkout hasta que un administrador la apruebe o canjee una invitación válida.

Ejecuta también `backend/supabase/migrations/006_admin_unlimited_usage.sql` para que las cuentas con `role = 'admin'` no estén sujetas a los límites diarios, mensuales ni de costo del plan. Su consumo continúa registrándose normalmente en los contadores y reportes de uso.

La vista **Administración → Control de acceso** permite aprobar, rechazar, suspender y reactivar cuentas. Las invitaciones son aleatorias, se almacenan únicamente como SHA-256, pueden limitarse a un correo, expiran y sólo pueden usarse una vez.

### Bot protection

Como capa adicional, crea un sitio en Cloudflare Turnstile o hCaptcha y habilítalo en Supabase: **Authentication → Settings → Bot and Abuse Protection → Enable CAPTCHA protection**. CAPTCHA reduce automatización, pero el control de costo permanece en `requireApprovedUser`, las cuotas diarias/mensuales y el backend.

Mantén también deshabilitado **Allow anonymous sign-ins**. Para una beta exclusivamente por invitación puedes desactivar **Allow new users to sign up** después de que los participantes invitados ya existan en Auth; para recibir solicitudes públicas controladas, déjalo habilitado y usa el estado `pending`.
