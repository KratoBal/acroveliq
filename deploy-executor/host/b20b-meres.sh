#!/usr/bin/env bash
# B20b, step 0 (task b20b-coolify2-tailnet): READ-ONLY measurement on the AI machine (the test
# machine, coolify2), run by the owner as root. It changes nothing. Its output decides the exact
# text of the Traefik file that keeps only /webhooks/ open on coolify2's public name.
#
# What it prints (names, rules and paths only; it never prints a file whole, so no credential in
# a dynamic file can reach the output):
#   1. the Traefik version of Coolify's proxy;
#   2. the dynamic config directory, and from each file only its router and middleware lines;
#   3. every webhook route Coolify defines (a GitHub call outside /webhooks/ would be lost silently
#      once the public name is closed: barracuda, plan review, point 4);
#   4. this machine's tailnet address (the executor's ai-gep target).
set -u
PROXY="${PROXY:-coolify-proxy}"
APP="${APP:-coolify}"
DYN="${DYN:-/data/coolify/proxy/dynamic}"

echo "== 1. Traefik"
if docker inspect "$PROXY" >/dev/null 2>&1; then
  docker exec "$PROXY" traefik version 2>&1 | grep -E '^(Version|Codename)' || echo "  a traefik version nem futott le"
else
  echo "  nincs $PROXY nevu kontener; a futo kontenerek:"; docker ps --format '  {{.Names}}  {{.Image}}'
fi

echo "== 2. Dinamikus konfiguracio: $DYN"
ls -la "$DYN" 2>&1 | sed 's/^/  /'
for f in "$DYN"/*.yaml "$DYN"/*.yml; do
  [ -f "$f" ] || continue
  echo "  -- $f"
  grep -n -E '^\s*(http|routers|services|middlewares|entryPoints|rule|service|priority|tls|certResolver|loadBalancer|url|redirectScheme|[A-Za-z0-9_-]+:)\s*' "$f" \
    | grep -v -i -E 'password|secret|token|users|basicauth|key' | sed 's/^/     /'
done

echo "== 3. A Coolify webhook-utvonalai"
if docker inspect "$APP" >/dev/null 2>&1; then
  docker exec "$APP" sh -c 'grep -n -E "Route::(get|post|put|patch|delete|any)" /var/www/html/routes/webhooks.php 2>/dev/null' \
    || echo "  a routes/webhooks.php nem olvashato"
  docker exec "$APP" sh -c 'grep -rn -E "webhooks" /var/www/html/routes/web.php 2>/dev/null | head -20'
else
  echo "  nincs $APP nevu kontener"
fi

echo "== 4. Tailnet-cim"
tailscale ip -4 2>&1 | sed 's/^/  /'
echo "KESZ: a fenti kimenetet kerem vissza (titkot nem tartalmaz). Ez a szkript semmit nem valtoztatott."
