# AutoTranslate

Traductor en vivo para conversaciones de Teams, Zoom, YouTube u otra fuente capturada desde el navegador.

## Como correrlo

1. Copia `backend/.env.example` a `backend/.env`.
2. Agrega tu `GEMINI_API_KEY`.
3. Instala dependencias:

```bash
npm install --workspaces
```

4. Inicia backend y frontend:

```bash
npm run dev
```

Frontend: `http://localhost:5173`
Backend: `http://localhost:4000`

## Notas del MVP

- No almacena audio ni transcripciones.
- El navegador pide seleccionar la fuente a capturar. Para baja latencia, usa Chrome o Edge y marca la opcion de compartir audio cuando aparezca.
- La captura de audio de apps nativas depende del soporte del navegador/sistema operativo. YouTube y pestanas del navegador suelen funcionar mejor que apps nativas.
