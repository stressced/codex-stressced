# Actualización selectiva de Codex Stressced

Referencia verificada el 1 de septiembre de 2026: Codex CLI estable
`rust-v0.152.0`, commit `7f6bee13af649d0da23ac0c2bf5c83f571fcd611`.
Base de este fork: `30607ad677`. Rama de trabajo: `codex/selective-cli-0.152`.

Esta actualización adapta cambios concretos a la implementación local existente.
No convierte el fork completo en Codex CLI 0.152.0 ni cambia su número de versión.

## Cambios incluidos

| Área | Cambio y beneficio | Procedencia |
| --- | --- | --- |
| Recuperación tras compactar | Guarda un checkpoint de los ajustes actuales después del contexto del turno. Al reanudar, solo recupera el directorio de snapshots pertenecientes a esa sesión. Los históricos sin propietario conservan el directorio inicial. Un bloqueo ordena actualizaciones aceptadas y checkpoints. | Adaptación de [#41567](https://github.com/openai/codex/pull/41567), `f5636bb733c4653a6b91413fed1aaf8842374f2e` |
| Ctrl+C en Windows | `write_stdin` acepta Ctrl+C para detener procesos sin TTY, conserva la salida disponible y sigue rechazando texto ordinario si stdin está cerrado. | Adaptación de [#35655](https://github.com/openai/codex/pull/35655), `6b23635a7e8d92862940702a2ec65c1226402cdb` |
| Historial de Electron | Reanuda con `excludeTurns`, carga 30 turnos por página mediante `thread/turns/list` y permite recuperar los anteriores. Usa `thread/read` con `includeTurns` para servidores sin paginación. Conserva herramientas, errores, razonamiento, imágenes y eventos de subagentes. | Integración local con la API v2 existente; sustituye la lectura completa y síncrona del JSONL en la interfaz |
| Estado de la conversación | Muestra tokens de contexto, ventana del modelo, estado y botón de compactación. Separa eventos por sesión y mensajes por ID; ignora respuestas atrasadas al navegar. | Correcciones específicas del cliente Stressced |
| Subagentes y catálogo local | El proveedor llama.cpp ofrece exclusivamente los modelos de su servidor, con caché separada por endpoint. Los alias locales no heredan niveles de razonamiento de OpenAI. Los errores HTTP no se guardan como un catálogo vacío válido. | Corrección del fork, motivada por las sesiones proporcionadas |
| Handoff local | Prompt de compactación para llama.cpp que conserva objetivo, restricciones, idioma, correcciones y estado comprobado. No inventa capacidades ni autorizaciones. Un prompt personalizado del usuario sigue teniendo prioridad. | Ajuste local; las plantillas genéricas de compactación ya coinciden con la referencia estable |
| Workspace de Electron | Selector de carpeta persistente para conversaciones nuevas. La ruta seleccionada se envía como `cwd`, se conserva en el estado de la conversación y sirve de base para adjuntos con rutas relativas. | Integración local con `thread/start` v2 |
| Computer Use local | Herramienta opcional por conversación para capturar la pantalla principal y ejecutar ratón, teclado, scroll y espera cuando el usuario lo pide. Las coordenadas usan la resolución física completa de Windows. | Adaptación local mediante dynamic tools de app-server v2 |
| Capturas sin reducción | El botón de adjunto y las rutas absolutas o relativas conservan los bytes originales; las data URLs pasan intactas. Ctrl+V conserva las dimensiones nativas y, cuando Electron lee una imagen del portapapeles del sistema, la representa como PNG sin cambiar su resolución. La app no aplica límite de tamaño ni reducción a 1200×675. | Corrección específica del cliente Stressced |

Los subagentes existentes son sesiones reales con ejecución y herramientas propias.
La capacidad de inferencia simultánea depende de la configuración y recursos del servidor
llama.cpp; esta actualización no presupone varias inferencias paralelas.

## Comprobación de uso real

La sesión `01a05ec0-98ff-7fa2-97d2-4882cec43c9a` contiene 69 registros JSON
válidos, dos turnos completados y ocho pares de llamada/resultado de herramientas.
Los tres comandos terminaron con código 0 y las tres ediciones terminaron sin error.
No hay estados fallidos, cancelados o incompletos, ni objetos de error. No ocurrió una
compactación: el último turno usó 43,659 de 146,300 tokens de contexto, cerca del 30%.

## Límites de esta selección

- Se mantiene el runtime local de Responses API y sus adaptaciones. No se importan
  servicios cloud, autenticación de OpenAI, Guardian ni cambios ajenos al uso local.
- La paginación de la interfaz no equivale a importar la nueva lectura acotada del
  contexto de modelo de #32896, ni la nueva representación de históricos heredados
  de #33432. Esos cambios requieren una migración más amplia del almacenamiento.
- No se importa parcialmente el límite MCP por herramienta de #41421: depende de
  metadatos de historial nuevos para que el límite siga siendo correcto tras reanudar.
  Se conserva el presupuesto de salida configurado actualmente.
- La interrupción de procesos sin TTY no incorpora Windows Job Objects ni promete
  resolver todos los bloqueos de programas gráficos o de sus procesos descendientes.
- La mejora del prompt reduce errores de handoff, pero no garantiza que un modelo
  local respete siempre todas las instrucciones.
- Electron entrega las capturas completas al adaptador local, pero el modelo o su
  procesador visual en llama.cpp todavía puede reescalarlas internamente.

## Verificación

Pruebas específicas de catálogo y proveedor, historial y estado de Electron,
checkpoints de compactación, sesiones heredadas y Ctrl+C en Windows. La interfaz
incluye snapshots `insta` de contexto y estados de herramientas, generados desde los
componentes React reales, además de una vista local aislada en `test/preview.html`.

La generación de esquemas de app-server se ejecutó en una carpeta temporal porque
Windows bloqueó la escritura directa de un archivo; la comparación con los esquemas
versionados no produjo cambios. El nuevo propietario del checkpoint es metadata
del rollout y no cambia el contrato público v2.

- Catálogo y proveedores: 63 pruebas aprobadas en la primera ejecución específica.
- Core, rollout, protocolo, app-server-protocol y proveedor: 2,334 pruebas ejecutadas;
  2,329 aprobadas y cinco fallos de serialización de imágenes. Los cinco se
  reprodujeron en un worktree limpio de `30607ad677`, sin estos cambios. No se
  alteró la serialización local de imágenes para ocultar esos fallos previos.
- Electron: trece pruebas de comportamiento aprobadas y comprobación de TypeScript.
- Snapshots `insta` de React: aprobados tras revisar las doce salidas esperadas.
- Computer Use real: captura nativa de 2560×1440, recorte PNG de 1200×900 y
  ratón/teclado Unicode comprobados en una ventana Electron aislada.
- Adjuntos: prueba byte a byte con una imagen de más de 2.5 MB, ruta relativa al
  workspace y data URL pegada sin modificación.
- Navegador: historial anterior visible, estado de herramientas correcto, bloqueo
  durante compactación y actualización del contador al terminar, con datos de prueba.
- Los benchmarks de imágenes que ejecuta `just test` pasaron en las ejecuciones exitosas.
- Suite global autorizada: 9,503 pruebas ejecutadas; 9,443 aprobadas, 59 fallidas,
  una agotó el tiempo y 66 fueron omitidas. Se ejecutaron los 60 casos no aprobados
  sobre un worktree limpio de `30607ad677`: 49 volvieron a fallar allí. Los once
  restantes pasaron al repetirlos en esta rama después de corregir la persistencia
  de ajustes y ofrecer `python3` a los hooks en Windows. Incluyen los tres casos de
  ajustes antes del primer turno, cinco casos de hooks/compactación, dos de eventos
  de subagentes y el proceso de PowerShell que había agotado el tiempo.
- Clippy completo se detuvo en un `expect_used` previo de `utils/image`. La revisión
  acotada de `codex-core` y `codex-rollout` terminó correctamente al excluir lints
  previos del archivo del usuario `stressced_edit_guard.rs`.
- `just fmt` terminó correctamente. No se repitieron pruebas después del formato,
  conforme a `AGENTS.md`; el build posterior recompiló el backend y TypeScript.

La suite global del workspace se ejecutó mediante `just test`, sin `--all-features`.

## Artefacto

Build portable Full generado correctamente; los artefactos de compilación no se
versionan en el repositorio.

- Tamaño: 131.03 MiB (137,390,004 bytes).
- SHA-256: `FC2997277CF1C83E6734897CE8C3F2527891A7BF75C5F09E6474F6DDC9D72FAA`.
- La versión visible continúa en `0.1.0`: esta selección toma `rust-v0.152.0` como
  referencia técnica, pero no declara que todo el fork sea Codex CLI 0.152.0.

## Electron: queue, steer y conexión — 2026-10-14

- Enter/Send encola durante un turno; Steer utiliza `turn/steer` con
  `expectedTurnId`. Stop interrumpe y pausa la cola. Los pendientes se pueden
  editar o quitar, conservan adjuntos y pertenecen a su conversación aunque se
  seleccione otra. La cola vive en memoria: sobrevive a reconexiones, pero no a
  cerrar la aplicación. Después de una desconexión se reanuda explícitamente.
- Las solicitudes esperan la apertura del WebSocket y el handshake completo.
  Hay reconexión con espera progresiva, rechazo inmediato de solicitudes
  pendientes al desconectar y recuperación del estado inicial del renderer.
  No se reenvían mutaciones automáticamente cuando su entrega es incierta.
  Si el puerto habitual está ocupado y no responde, se usa otro puerto local
  sin terminar procesos ajenos. Los errores del backend se registran también
  sin activar los logs de depuración.
- Los deltas se agrupan por cuadro y se vacían antes de eventos de finalización.
  Se eliminó el límite de 200 ms del Markdown; el historial y sus filas se
  renderizan independientemente del compositor. El autoscroll sigue el DOM
  actualizado y el compositor recalcula su altura al cambiar de ancho.
- Validación: TypeScript, 32 pruebas Node, siete estados nuevos en el snapshot
  `insta` existente (comparados también desde Node), prueba interactiva de
  Queue/Steer/Stop/edición y handshake + `thread/list` con el backend real en un
  puerto aislado. Replay de unos 6 KB con código y tablas: aproximadamente
  60 actualizaciones/s, render medio de 5.7 ms y máximo de 12.3 ms en esta máquina.
  Son medidas de la interfaz con datos simulados, no de inferencia de Qwen.
- No hubo cambios en Rust ni se repitió su suite global. El portable incluye
  el backend previamente validado, extraído del artefacto anterior cuyo SHA-256
  coincide con el registrado arriba. Frontend, preload, main y backend del
  paquete se comprobaron byte a byte contra los archivos de compilación.

Portable Full: `D:\codex-selective-upgrade-work\2026-10-14\Codex Stressced Full 0.1.0.exe`.
Tamaño: 137,394,480 bytes. SHA-256:
`8039580369B9A9240C8880359B4CFD1787F4F98597B36FAE5B191AA76275C5FF`.
Los archivos generados de compilación se movieron a `build-cache` junto al
portable, fuera del repositorio, tras el bloqueo automático de su eliminación.

## Electron: wrappers del portable y diagnóstico de Computer Use — 2026-10-15

Sesión revisada: `01a140c8-0eb0-7eb1-9138-daed260168fe`, con Qwen3.6
35B A3B. Se completaron tres turnos, sin compactación ni errores de transporte
MCP registrados. Computer Use devolvió capturas de 2560×1440.

- El wrapper local `APPLY_PATCH` existía, pero falló al resolver el ejecutable:
  sus rutas de respaldo apuntaban a directorios de compilación ya retirados.
  Electron ahora exporta `CODEXSTRESSCED_EXE` con la ruta absoluta del backend
  que inicia, también si se selecciona un binario personalizado. El wrapper y
  los shells heredan esa ruta; ya no dependen del árbol de compilación. No se
  modifica el guard de borrado ni la configuración personal del usuario.
- Las acciones inválidas de Computer Use se rechazan antes de consultar
  coordenadas/pantalla y reciben las acciones disponibles y un ejemplo de
  `click`. En la sesión el modelo había enviado `left_click` y luego corrigió
  su llamada. No se agregan alias ni acciones automáticas.
- Otros errores observados: índices incorrectos de `Substring`, parámetros
  `-LiteralPath` sin argumento y una edición grande que Safe Edit rechazó antes
  de aceptar el reintento explícito. Los errores de PowerShell podían aparecer
  junto a exit code 0 por comandos posteriores; el log no acredita éxito de
  esas operaciones. Son fallos en los comandos del modelo, no una razón para
  relajar protecciones ni cambiar la semántica general de PowerShell.
- Validación: TypeScript y 35 pruebas Node aprobadas. El smoke test con backend
  real usa un CODEX_HOME y puerto aislados; `command/exec` hereda el entorno,
  llama al mismo `apply_patch.bat` de la sesión y crea/elimina un JSON temporal
  mediante parches, verificando códigos de salida, contenido y existencia.
  No usa inferencia ni modifica el sitio web del usuario. No hay cambios Rust.
- La ruta se proporciona al backend iniciado por esta versión. Para usarla,
  cerrar la versión anterior y abrir el nuevo portable. Un app-server externo
  iniciado manualmente conserva su propio entorno y no se modifica al conectar.

Portable Full: `D:\codex-selective-upgrade-work\2026-10-15\Codex Stressced Full 0.1.0.exe`.
Tamaño: 137,396,232 bytes. SHA-256:
`A549BE92C2AFA34D78B1999150550BAE7C2FF298C83B20572C3A6D3EE3DFBFB5`.
Se verificaron los siete archivos de frontend/main/preload del paquete contra
los compilados y el hash del backend sin cambios. Los directorios generados
se conservaron fuera del repo, en `build-cache` y `release-full` junto al portable.
