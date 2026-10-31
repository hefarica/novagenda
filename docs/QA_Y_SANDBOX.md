# QA y sandbox de código del Estudio (t52)

> El Estudio produce borradores (presentación, documento o proyecto de código). Antes de
> marcar un encargo como **publicable**, pasa por dos filtros independientes:
> **sandbox de ejecución** (solo código) y **QA determinista + revisión LLM opcional**.
> Ningún entregable se publica si el QA determinista falla o si el sandbox queda
> `failed`/`blocked`.

## 1. Flujo

1. El worker de la cola genera el artefacto (`presentation`, `document`, `code`).
2. Si es `code`:
   - `lib/studio/sandbox.mjs` escanea los archivos y, si son seguros, ejecuta **solo**
     `node --test` en una copia aislada.
   - El resultado se guarda en `job.sandbox` (`passed | failed | blocked | skipped`).
3. `lib/studio/qa.mjs` revisa estructura + sandbox y, si hay LLM, añade una revisión
   independiente. El resultado se guarda en `job.qa` (`verdict`, `checks`, `findings`,
   `reviewer`, `checkedAt`).
4. `assessJobResult()` calcula `job.publishable`:
   `qa.verdict === "pass" && sandbox.status ∉ {failed, blocked}`.
5. El job queda `done` con `publishable` y la evidencia completa; un job no publicable
   **no se reintenta** automáticamente (no es un fallo de generación, es un resultado QA).

Estados del sandbox:

| Estado | Significado |
|---|---|
| `passed` | Las pruebas del proyecto pasaron en el sandbox. |
| `failed` | Las pruebas fallaron, agotaron el timeout o la salida superó el límite. |
| `blocked` | El escaneo estático encontró código riesgoso; **no se ejecutó nada**. |
| `skipped` | El proyecto no incluye pruebas ejecutables (`tests/` o `*.test.js`). |

## 2. Sandbox (`lib/studio/sandbox.mjs`)

- **Ejecución**: `execFile(process.execPath, ['--test', '--test-isolation=none',
  '--test-concurrency=1', '--test-reporter=tap', ...tests], { cwd: sandbox, env, shell:false })`.
  Sin shell, sin heredar el entorno del servidor, `windowsHide: true`, salida máxima
  512 KB y timeout por defecto **30 s** (`killSignal: SIGKILL`; las pruebas inyectadas
  con `--test-isolation=none` corren en el mismo proceso y no dejan huérfanos).
- **Aislamiento**: el `cwd` es `data/studio/jobs/<id>/sandbox`, una copia limpia de los
  archivos del artefacto (solo extensiones de texto). Se añade `package.json`
  `{"type":"module"}` si el proyecto no lo trae. Se rechaza cualquier directorio que no
  esté dentro de `data/studio/jobs` (nunca el repo ni el `DATA_DIR` real).
- **Entorno mínimo**: solo `PATH`, `SystemRoot`/`windir`, `TEMP`/`TMP` (dentro del
  sandbox), `NODE_ENV=test`, `NO_COLOR` y `TZ`. **No** se pasan `DATA_DIR`, `APP_SECRET`,
  claves de API ni tokens.
- **Escaneo estático** (antes de copiar/ejecutar). Rechaza:
  - imports/`require` de `child_process`, `cluster`, `worker_threads`, `net`, `http`,
    `https`, `http2`, `dns`, `tls`, `dgram`, `vm`, `repl`, `inspector`, `module`;
  - `eval`, `Function`, `new Function` (código dinámico);
  - `exec`/`spawn`/`fork`/`execFile` (shell/procesos);
  - `fetch`, `XMLHttpRequest`, `http(s).get/request`, `curl`, `wget` (descargas/red);
  - `process.binding/dlopen/kill/exit/abort/chdir`;
  - `fs` con APIs de escritura (`writeFile`, `mkdir`, `rm`, `unlink`, `rename`, `copyFile`,
    `createWriteStream`, `open` con escritura, etc.);
  - `fs` con rutas absolutas o que contengan `..` (evita escribir/leer fuera del job).
- Si el código es riesgoso: `blocked`, con `reason` y `findings` (código, archivo, línea,
  detalle). No se crea la carpeta `sandbox/`.
- **Límites**: 60 archivos por job, 256 KB por archivo de código, 120 KB por archivo
  generado (jobs). El sandbox no instala dependencias ni ejecuta `npm`/`pnpm`/`yarn`.

## 3. QA independiente (`lib/studio/qa.mjs`)

- Checks deterministas:
  - **presentation**: ≥6 diapositivas, primera `cover`, notas del orador, PPTX descargable.
  - **document**: DOCX registrado y con secciones.
  - **code**: archivos, `README.md`, tests presentes y **sandbox `passed`**.
- Cualquier check `false` o finding `blocker/high` ⇒ `verdict = needs_revision`,
  `publishable = false`. El sandbox `failed`/`blocked` es blocker/high y además bloquea
  `publishable` de forma explícita.
- **Autoridad**: el veredicto determinista manda. La revisión LLM (si está configurada)
  solo puede **empeorar** el resultado: si devuelve `needs_revision` se añaden findings
  medium; si devuelve `pass` con checks fallidos, el veredicto sigue siendo
  `needs_revision`. Si el LLM no está disponible o no devuelve JSON válido, no se
  degrada la publicación (`reviewerPass: null`).
- Se registra `reviewer: "QA independiente"`, `reviewerId: "studio-qa"`, `checks`,
  `findings`, `failedChecks`, `deterministicFailed`, `provider/model` (si hubo LLM),
  `llmError` y `checkedAt`. Todo queda dentro de `job.qa`.

## 4. Evidencia en el job

```json
{
  "status": "done",
  "publishable": false,
  "sandbox": {
    "status": "failed",
    "executed": true,
    "timedOut": false,
    "tap": { "tests": 2, "pass": 1, "fail": 1 },
    "durationMs": 412,
    "scannedFiles": ["src/index.js", "tests/index.test.js"],
    "findings": [],
    "stdoutTail": "..."
  },
  "qa": {
    "verdict": "needs_revision",
    "deterministicFailed": true,
    "failedChecks": ["sandbox"],
    "findings": [{ "severity": "high", "problem": "Sandbox failed: ..." }],
    "reviewer": "QA independiente",
    "reviewerId": "studio-qa",
    "checkedAt": "2026-10-31T..."
  }
}
```

## 5. Verificación

```bash
node --check lib/studio/sandbox.mjs lib/studio/qa.mjs lib/studio/jobs.mjs
node scripts/verify-studio-sandbox.mjs     # 28 comprobaciones (fixtures + QA + cola real)
npm run check
npm test
npm run verify:studio -- http://127.0.0.1:<puerto-temporal>
```

Fixtures de `verify-studio-sandbox.mjs` (siempre con `DATA_DIR` temporal):

| Fixture | Resultado esperado |
|---|---|
| `README.md` + `src/index.js` + `tests/index.test.js` (node:test) | `passed`, TAP 1/1 |
| test con `assert.equal(1, 2)` | `failed`, TAP fail=1 |
| `child_process` + escritura de archivo fuera del job | `blocked`, sin ejecutar; no crea `pwned.txt` ni el archivo externo |
| proyecto sin tests | `skipped` |
| test con bucle infinito | `failed`, `timedOut=true`, < 5 s (timeout de prueba 700 ms) |
| `fs` con ruta absoluta | `blocked` |
| directorio fuera de `data/studio/jobs` (repo) | excepción, no ejecuta |
| sandbox failed + revisor LLM que dice `pass` | QA `needs_revision`, `publishable=false` |
| job de código seguro (artefacto real) | QA `pass`, `publishable=true` |
| job de código con tests fallidos | QA `needs_revision`, `publishable=false` |
| job sin tests | `skipped`, `publishable=false` |
| cola real: encargo `code` generado y ejecutado | `done`, sandbox `passed`, QA `pass`, `publishable=true` |

## 6. Límites conocidos

- El escaneo es **estático y conservador**: puede bloquear código legítimo que mencione
  APIs prohibidas en comentarios o cadenas; el job queda `blocked` y se corrige el
  proyecto. No sustituye a un contenedor/VM: `node --test` corre con el usuario del
  proceso, pero sin shell, red, entorno del servidor ni acceso al repo por diseño.
- Un test puede consumir CPU hasta el timeout de 30 s (el runner limita la salida, no la
  CPU); el worker del Estudio procesa un job a la vez.
- El sandbox no instala dependencias: los proyectos generados deben usar solo built-ins.
- `verify:studio` (UI) sigue siendo una verificación de navegador contra una instancia
  concreta; este documento cubre la parte de ejecución/QA, que es independiente de la UI.
