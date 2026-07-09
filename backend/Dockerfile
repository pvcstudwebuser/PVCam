# CAMTRACK backend — Node server that self-installs headless Blender
# on first boot and converts camera-path JSON into real FBX files.
#
# Build & run locally:
#   docker build -t camtrack-backend .
#   docker run -p 8787:8787 camtrack-backend
#
# Deploys as-is to Railway, Render, Fly.io, or any Docker-based host.

FROM node:20-bookworm-slim

# Blender's Linux build needs a handful of shared libraries that a
# minimal Debian image doesn't ship by default (OpenGL/X11 stubs,
# even in --background mode, plus basic fonts and SSL/TLS for the
# download step). tar/xz are needed to extract the Blender archive.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tar \
    xz-utils \
    libxi6 \
    libxrender1 \
    libxfixes3 \
    libxkbcommon0 \
    libgl1 \
    libsm6 \
    libice6 \
    fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js camtrack_to_fbx.py ./

# Blender auto-installs itself into ./vendor/blender on first run;
# make sure that's writable and persists for the life of the container.
RUN mkdir -p /app/vendor

ENV PORT=8787
EXPOSE 8787

# Optional: pre-warm Blender at build time instead of on first request,
# so the container's first real conversion is fast. Uncomment to bake
# Blender into the image itself (adds ~350MB to image size but removes
# first-request latency and the runtime internet dependency).
# RUN node -e "require('./server.js')" & sleep 5 && kill %1 || true

CMD ["node", "server.js"]
