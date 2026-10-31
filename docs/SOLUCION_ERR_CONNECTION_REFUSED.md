# Solución — ERR_CONNECTION_REFUSED

Si el navegador muestra `localhost rechazó la conexión`, significa que no hay un servidor escuchando en ese puerto.

En la versión 1.0 el navegador se abría antes de comprobar que Node.js hubiera iniciado. Además, el lanzador usaba `--env-file`, incompatible con versiones antiguas de Node.

La versión 1.1 corrige ambos puntos:

1. Valida que el ZIP esté completamente extraído.
2. Comprueba Node.js 18 o superior.
3. Puede ofrecer instalar Node LTS con `winget` si falta.
4. Crea `.env` automáticamente.
5. Comprueba si 3000 está ocupado y usa 3001/3010 si es necesario.
6. Arranca el servidor en una ventana separada.
7. Espera hasta 40 segundos a `/api/health`.
8. Solo entonces abre el navegador.

## Uso recomendado

- Borra o renombra la carpeta anterior.
- Extrae **todo** el ZIP corregido a una carpeta local, por ejemplo `C:\AgendaCopilot`.
- No ejecutes el `.bat` desde la vista interna del ZIP.
- Haz doble clic en `START_WINDOWS.bat`.
- Mantén abierta la ventana `Agenda Copilot P95 - Servidor` mientras uses la aplicación.

Si falla, ejecuta `DIAGNOSTICO_WINDOWS.bat` y comparte el archivo `agenda-diagnostico.txt`.
