# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# PH Google — React frontend
#
# Vite output is static files. Node is needed to produce them and never to
# serve them, so the runtime stage is nginx with the build stage discarded.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Vite inlines VITE_* variables at build time, so this is baked into the
# bundle rather than read at runtime. It is the URL the *browser* uses, which
# is the host's published port — not the compose service name, which only
# resolves inside the network.
ARG VITE_API_BASE_URL=http://localhost:5000/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY . .
RUN npm run build


# nginx-unprivileged runs as uid 101 and listens on 8080 out of the box.
# Plain `nginx:alpine` starts its master process as root and needs a port
# below 1024; this image is the same server without either problem.
FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

# busybox wget, since the alpine image has no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:8080/ || exit 1
