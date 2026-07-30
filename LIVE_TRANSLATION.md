# Intérprete Live

Este módulo es independiente del traductor por fragmentos. El modo existente continúa
usando `POST /api/translate/audio`; Live usa `WebSocket /api/live`.

## Activación

1. Ejecutar `backend/supabase/migrations/005_live_translation.sql` en Supabase.
2. Configurar en `backend/.env`:

```env
GEMINI_LIVE_MODEL=gemini-3.5-live-translate-preview
LIVE_TRANSLATION_ENABLED=true
LIVE_TRANSLATION_ADMIN_ONLY=true
GEMINI_LIVE_ESTIMATED_USD_PER_MINUTE=0
```

Antes de habilitar usuarios de pago, reemplazar el costo por minuto con una estimación
calculada a partir de la tarifa oficial vigente. Con valor `0`, se controlan los minutos
del plan, pero el costo monetario mostrado para Live queda en cero.

## Prueba local

1. Reiniciar `npm run dev`.
2. Entrar con un usuario administrador aprobado.
3. Abrir **Intérprete Live**.
4. Seleccionar idioma y pulsar **Iniciar Live**.
5. Compartir una pestaña, ventana o pantalla activando la opción de compartir audio.

Se recomienda usar auriculares para impedir que la voz traducida vuelva a entrar en la
captura. El historial se consolida cuando termina la sesión.

## Regreso seguro

Para ocultar Live sin afectar el traductor estable:

```env
LIVE_TRANSLATION_ENABLED=false
```
