# Caddy with the Hostidian Caddyfile baked in (no bind mount), for platforms such as Coolify that run the
# compose project from a different filesystem than the one that holds the repository.
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
