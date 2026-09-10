# MCP `chrome-devtools`

Le da a los agentes de LibreChat control de un navegador Chrome real (Chrome DevTools
Protocol) para inspeccionar, depurar y automatizar páginas web. Ver `chrome-devtools`
en [`librechat.yaml`](../librechat.yaml).

## Cómo funciona

1. Cuando un chat/agente abre una sesión con la herramienta `chrome-devtools`, LibreChat
   (contenedor `api`) ejecuta el comando configurado en `librechat.yaml`:

   ```
   docker run -i --rm --init --shm-size=1g --network=bridge \
     --cap-drop=ALL --security-opt=no-new-privileges --read-only \
     --tmpfs=/tmp:rw,size=512m --tmpfs=/root:rw,size=512m \
     --pids-limit=256 --memory=1g --cpus=1 \
     librechat-chrome-devtools-mcp:local
   ```

2. `api` no tiene el socket de Docker montado directamente. Habla con el daemon del
   host a través de **`docker-socket-proxy`** (`tecnativa/docker-socket-proxy`), que
   solo permite las llamadas de la API de Docker estrictamente necesarias para crear,
   arrancar, parar y borrar contenedores, y para tirar de imágenes (`CONTAINERS`,
   `IMAGES`, `POST`) — todo lo demás (exec, volumes, networks, swarm, secrets, system,
   auth...) está bloqueado por defecto. Esto se indica con `DOCKER_HOST` en el `env:`
   de la entrada `chrome-devtools` (y de `playwright`) en `librechat.yaml`, porque
   LibreChat lanza los procesos MCP con un entorno restringido — no hereda el
   `environment:` del contenedor `api`.

3. Se levanta un contenedor **nuevo y efímero** (`--rm`) con la imagen
   [`chrome-devtools-mcp/Dockerfile`](Dockerfile): Node + Chromium + el paquete
   `chrome-devtools-mcp` preinstalados. Ese proceso lanza su propio Chrome headless
   dentro del contenedor, pasándole `--no-sandbox` vía el flag oficial `--chrome-arg`
   del propio CLI (soportado desde chrome-devtools-mcp v0.8.0,
   [PR #338](https://github.com/ChromeDevTools/chrome-devtools-mcp/pull/338)) — Chrome
   lo exige para arrancar como root dentro de un contenedor.

4. Todo el protocolo MCP (JSON-RPC) viaja por **stdio** entre `api` y ese contenedor —
   no hay ningún puerto TCP expuesto, ni al host ni a la red interna de Docker.

5. Al cerrar la sesión (o cuando el cliente MCP se desconecta), el contenedor se
   destruye (`--rm`). La siguiente sesión arranca uno completamente nuevo: perfil de
   Chrome limpio, sin cookies ni almacenamiento de sesiones anteriores.

## Aislamiento aplicado (mismo patrón que `playwright`)

| Medida | Qué evita |
|---|---|
| `docker run --rm` por sesión | Estado (cookies, localStorage, pestañas) compartido entre conversaciones o usuarios distintos |
| Sin puertos publicados (todo por stdio) | Que otro contenedor de la red Docker alcance el DevTools Protocol |
| `docker-socket-proxy` (no socket crudo) | Que el contenedor `api`, si se ve comprometido, tenga acceso root-equivalente al daemon Docker del host |
| `--network=bridge` (no la red interna de LibreChat) | Que el navegador controlado por el agente pueda llegar a `mongodb`, `rag_api`, `meilisearch`, etc. |
| `--cap-drop=ALL` + `--security-opt=no-new-privileges` | Escalada de privilegios dentro del contenedor del navegador |
| `--read-only` + `tmpfs` para `/tmp` y `/root` | Persistencia de cambios en el filesystem del contenedor entre ejecuciones (aunque igual muere con `--rm`) |
| `--pids-limit`, `--memory`, `--cpus` | Que una página o instrucción maliciosa agote memoria/CPU/procesos del host |

## Riesgos que quedan (ningún diseño es 100% seguro)

- **El agente controla un navegador real con salida a internet.** Puede navegar a
  cualquier URL — incluida una página maliciosa que intente instrucciones de prompt
  injection contra el propio agente, o abusar de la sesión para exfiltrar datos que el
  agente sí tenga en contexto (aunque el navegador arranque "limpio", el agente puede
  pegar credenciales o texto sensible en un formulario si se le pide).
- **Sin restricción por rol específica de este MCP.** El Admin Panel de LibreChat solo
  permite activar/desactivar el permiso `MCP_SERVERS` de forma global por rol (no hay
  today un selector "este usuario puede usar `playwright` pero no `chrome-devtools`").
  Si se da acceso a MCP a un rol, ese rol puede usar `chrome-devtools` también.
- **`--network=bridge` sigue teniendo salida a internet.** El contenedor efímero puede
  llegar a cualquier host público — es necesario para que la herramienta sirva para
  navegar, pero es superficie real si el agente es manipulado.
- **Uso de recursos del host.** Cada sesión activa consume CPU/RAM del host Windows
  (limitado a 1 CPU / 1GB por el `--memory`/`--cpus`, pero varias sesiones concurrentes
  suman).

## Mitigación adicional recomendada (no aplicada, requiere decisión del usuario)

- Restringir el permiso `MCP_SERVERS` del Admin Panel solo al rol de administrador
  mientras esta instancia tenga usuarios no confiables — ver conversación previa.
