# Standalone image for the `chrome-devtools` MCP server (see librechat.yaml).
#
# Run as a fresh, throwaway container per MCP session via stdio (docker run
# -i --rm), the same isolation pattern already used for the `playwright`
# entry in librechat.yaml — a new browser and profile every session, nothing
# shared between conversations or users, no port exposed to the host or the
# LibreChat compose network.
#
# Chrome needs --no-sandbox to launch as the container's root user; that's
# passed via chrome-devtools-mcp's own --chrome-arg flag (added in v0.8.0,
# see https://github.com/ChromeDevTools/chrome-devtools-mcp/pull/338)
# instead of disabling Docker's own container sandboxing.
FROM node:24-alpine

RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont

RUN npm install -g chrome-devtools-mcp@1.9.0

ENTRYPOINT ["chrome-devtools-mcp", \
  "--executablePath=/usr/bin/chromium-browser", \
  "--headless", \
  "--isolated", \
  "--chrome-arg=--no-sandbox", \
  "--chrome-arg=--disable-setuid-sandbox", \
  "--chrome-arg=--disable-dev-shm-usage"]
