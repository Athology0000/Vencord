# Xicord sync server - self-hosted. The server is zero-dependency (only Node built-ins),
# so this image is tiny and needs no `npm install`. Runs the SAME code as Railway; the only
# difference is you control the RAM, so it can hold the full uncapped pool the 1GB tier could not.
FROM node:22-alpine

WORKDIR /app

# Only the runtime files (server.js reads xicord-app.html from its own dir, and requires
# ./merge ./pool ./auth ./pages). Tests, data and .env are excluded via .dockerignore.
COPY package.json server.js pool.js merge.js auth.js pages.js intel.js xicord-app.html ./

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    XICORD_MAINTENANCE=0 \
    # Room to hold the full uncapped pool in memory. Override via the compose file / -e.
    NODE_OPTIONS=--max-old-space-size=4096

EXPOSE 8080
# The pool slices, logs and tokens live here; mount a host dir so they survive `docker rm`.
VOLUME ["/data"]

CMD ["node", "server.js"]
