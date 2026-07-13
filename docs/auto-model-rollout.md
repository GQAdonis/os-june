# Automatic private model rollout

June supports `open-software/auto` while retaining explicit model selection. Auto persists a
Cost-to-quality preference and forwards it through Hermes and note generation.

The rollout remains reversible. Production compose pins
`JUNE__UPSTREAMS__VENICE__BASE_URL` to `https://api.opensoftware.co/v1` and reuses the existing
sealed June service credential, which os-api authorizes. This avoids replacing Phala's write-only
production environment just to change routing. Staging may instead provide the dedicated os-api
service key through the existing `JUNE__UPSTREAMS__VENICE__API_KEY` sealed secret.

Build the desktop release with `OS_JUNE_AUTO_MODE_DEFAULT=true`. Existing users retain their saved
model. Roll back by restoring the Venice URL in production compose and removing the build flag.
