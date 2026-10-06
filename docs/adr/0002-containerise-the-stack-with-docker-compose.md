# 0002. Containerise the stack with Docker Compose

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

Only OpenSearch was containerised. The backend and frontend ran from the host
with `npm start` and `npm run dev`, which meant that "run the project" was a
list of instructions rather than a command, that the Node version was whatever
the developer had, and that nothing verified the application worked anywhere
but one laptop.

MongoDB is a managed Atlas cluster, reached over the internet with credentials
in `ph-google-backend/.env`.

## Decision

Add multi-stage Dockerfiles for the backend and frontend and put both in
`docker-compose.yml`, so `docker compose up -d --build` starts the whole
stack with health checks and explicit ordering.

Both images run as a non-root user. The backend uses the `node` user from the
official image; the frontend uses `nginxinc/nginx-unprivileged`, which listens
on 8080 because a non-root process cannot bind a port below 1024.

MongoDB stays external by default. A `mongo:7` service exists behind the
`local-db` compose profile for anyone who wants a self-contained stack, opted
into with `--profile local-db` and one line in `.env`.

## Alternatives considered

**MongoDB as a default compose service.** Makes `docker compose up` genuinely
self-contained, which is the better first-run experience. Rejected because it
silently changes which database the app talks to: a developer with Atlas data
would start the stack, see an empty index, and have no obvious reason why. Two
plausible homes for the same data is a worse problem than one extra flag.

**A single image running both applications.** Fewer moving parts, but the two
have nothing in common — one is a Node process that must receive SIGTERM to
stop a crawl cleanly, the other is static files behind nginx. They also scale
differently and are rebuilt at different rates.

**`nginx:alpine` with a custom non-root setup.** Equivalent once configured,
but it means owning the permission and PID-file changes ourselves.
`nginx-unprivileged` is the same server maintained by the same team with that
work already done.

**Serving the frontend from Express.** One fewer container, but it puts static
file serving, caching headers and SPA routing into an application whose job is
the API, and couples frontend deploys to backend restarts.

## Consequences

Docker becomes a requirement for the documented workflow. `npm run dev` still
works for anyone who prefers running on the host.

`VITE_API_BASE_URL` is baked into the frontend bundle at build time, so
pointing the app at a different API means rebuilding the image rather than
restarting it. That is inherent to Vite, and the build argument makes it
explicit rather than surprising.

The containerised backend defaults to `NODE_ENV=production`, so responses
carry no stack traces. `NODE_ENV=development docker compose up` is the way
back when debugging.

OpenSearch still runs with its security plugin disabled. That is a local-only
choice; the secured configuration is documented at the bottom of
`docker-compose.yml` and must be used for anything reachable by more than one
person.
