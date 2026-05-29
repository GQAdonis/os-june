# Reproducible builds for `scribe-api`

> **Status:** plan — under review. Phase A not yet implemented.

## Why

When we open-source `os-scribe` we want to make a claim a skeptic can check
without trusting us:

> "The code in this public commit is **exactly** what runs in the TEE."

That requires a **trustless** link from source to the running image. Two trust
models exist:

- **Signed provenance** — trust our CI's signature that "digest X came from
  commit Y." (We dropped this in #44; we don't consume it.)
- **Reproducible builds** — anyone clones the repo at commit Y, rebuilds, gets
  the **same** digest X, and checks it against the TEE attestation. No trust in
  our CI required. **This is the model we want.**

## The chain a verifier walks

```
git clone @<commit> ──► docker build (deterministic) ──► digest D
                                                          ║ compare
Trust Center attestation ──► attested compose ──► pins @sha256:D ?  ✅
```

A match proves the running enclave is the published code. This chain proves the
**code only** — it does not prove anything about upstream model providers
(audio still leaves the TEE to OpenAI/Venice). Keep those claims separate.

## Scope: only the `runtime` stage matters

The Dockerfile is multi-stage. Only the final `runtime` image is published and
attested, so only inputs that reach it affect the digest:

1. the `scribe` binary (`COPY --from=builder`)
2. the `debian:bookworm-slim` base
3. the CA certificate bundle
4. file metadata (timestamps, ownership) in the layers

`chef` / `planner` / `builder` nondeterminism is irrelevant **except** through
the one binary they produce. So determinism work focuses on those four inputs,
not the whole build.

## Nondeterminism sources and fixes

| Source | Why it drifts | Fix |
|---|---|---|
| `FROM rust:1.95-bookworm` | tag floats across 1.95.x patches → different `rustc` → different codegen | pin `@sha256:<digest>` |
| `FROM debian:bookworm-slim` | tag moves | pin `@sha256:<digest>` |
| `apt-get install ca-certificates` | unpinned version, fetched at build time | `COPY` the cert bundle from the pinned base instead of `apt` (removes the fetch entirely) |
| `cargo build --release` binary | absolute paths in panic strings / debug info; build-id | `RUSTFLAGS=--remap-path-prefix=…`, `[profile.release] strip = true`, committed `Cargo.lock`, pinned toolchain |
| layer file mtimes | build wall-clock time | `SOURCE_DATE_EPOCH=<commit time>` + buildkit `rewrite-timestamp=true` |

## Phase A — make the build deterministic

Concrete changes (all reviewable before any CI run):

### 1. Pin base images by digest — `scribe-api/Dockerfile`

```dockerfile
FROM rust:1.95-bookworm@sha256:<resolve-at-impl> AS chef
...
FROM debian:bookworm-slim@sha256:<resolve-at-impl> AS runtime
```

Digests resolved with `docker buildx imagetools inspect <image:tag>` at
implementation time and committed.

### 2. Deterministic compiler flags — `scribe-api/Dockerfile` (builder stage)

```dockerfile
FROM chef AS builder
ENV CARGO_INCREMENTAL=0 \
    RUSTFLAGS="--remap-path-prefix=/app=. --remap-path-prefix=/usr/local/cargo=/cargo"
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --release --bin scribe
```

### 3. Strip the binary — `scribe-api/Cargo.toml`

```toml
[profile.release]
strip = true        # drop symbol table → deterministic + smaller
```

### 4. Pin the toolchain for non-Docker rebuilds — `scribe-api/rust-toolchain.toml` (new)

```toml
[toolchain]
channel = "1.95.0"   # must match the pinned rust base image's rustc
```

(The CI/Docker build's exact `rustc` is locked by the base-image digest; this
file makes a *local* `cargo build` outside Docker match.)

### 5. Replace apt certs with a copy — `scribe-api/Dockerfile` (runtime stage)

```dockerfile
FROM debian:bookworm-slim@sha256:<…> AS runtime
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin scribe
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --from=builder /app/target/release/scribe /usr/local/bin/scribe
COPY config.toml /app/config.toml
USER scribe
EXPOSE 8080
ENV RUST_LOG=scribe=info,scribe_api=info,scribe_services=info,scribe_providers=info,tower_http=info
ENTRYPOINT ["scribe"]
CMD ["serve"]
```

(The `rust` base ships `ca-certificates`, so the bundle is copied from a pinned
stage — no network fetch, no version drift.)

### 6. Reproducible image export — `.github/workflows/build-scribe-api.yml`

Compute the commit epoch and enable timestamp rewriting:

```yaml
      - name: Compute metadata
        id: meta
        run: |
          echo "sha_short=$(git rev-parse --short=7 HEAD)" >> "$GITHUB_OUTPUT"
          echo "epoch=$(git log -1 --pretty=%ct)"          >> "$GITHUB_OUTPUT"

      - name: Build and push
        id: build
        uses: docker/build-push-action@v6
        env:
          SOURCE_DATE_EPOCH: ${{ steps.meta.outputs.epoch }}
        with:
          context: scribe-api
          file: scribe-api/Dockerfile
          provenance: false
          sbom: false
          outputs: type=image,name=${{ env.IMAGE }}:${{ steps.meta.outputs.sha_short }},push=true,rewrite-timestamp=true
          # (tags handled via outputs name=…; drop the `tags:`/`push:` keys)
          ...
```

> Note: `rewrite-timestamp=true` requires the `outputs:` exporter form rather
> than `push: true` + `tags:`. Exact translation finalized at implementation.

## Phase B — prove it (iterative, needs real builds)

### `scripts/verify-reproducible.sh` (new)

```
Usage: verify-reproducible.sh <git-ref> <expected-digest>
  1. git worktree add /tmp/verify <git-ref>
  2. SOURCE_DATE_EPOCH=$(git -C /tmp/verify log -1 --pretty=%ct) \
       docker buildx build --provenance=false --sbom=false \
       --output type=image,rewrite-timestamp=true,push=false \
       --metadata-file /tmp/meta.json scribe-api
  3. local=$(jq -r '.["containerimage.digest"]' /tmp/meta.json)
  4. [ "$local" = "$expected" ] && echo PASS || { echo "FAIL $local != $expected"; exit 1; }
```

### CI guard — double-build job

A workflow job that builds twice and fails if the two digests differ, so a
dependency or Dockerfile change can't silently break reproducibility.

### Iteration

Bit-for-bit reproducibility usually takes 2–3 rounds: build twice, diff with
[`diffoci`](https://github.com/reproducible-containers/diffoci) to find the
remaining nondeterminism, fix, repeat. This needs actual build runs, so Phase B
is iterative — not a one-shot edit.

## Phase C — make the public claim

Only after two independent builds match:

- Update the README / #36 to the strong wording: "Rebuild from this commit and
  check the digest against the Trust Center attestation," with the exact steps.
- Until then, #36 should say "verify the running digest matches our public CI
  build for commit X" (true today) — do **not** ship "rebuild and check" before
  Phase B passes.

## Effort / risk

- **Phase A:** low risk, ~1 PR. Each change is independently sound; worst case a
  base-digest pin needs a bump. Does not by itself guarantee reproducibility.
- **Phase B:** medium, iterative, needs CI cycles to converge.
- **Phase C:** docs only, gated on B.

## Unresolved Questions

- Where do verifiers get the **attested digest** to compare against — scrape the
  Trust Center attested compose, or pin the digest into a git release manifest
  for a fully in-repo chain?
- Pin `ca-certificates` by copying from the base, or commit a vendored bundle in
  the repo (fully self-contained, but we own cert updates)?
- Toolchain: is locking via the base-image digest enough, or do we also want
  `rust-toolchain.toml` enforced in CI (fail if drift)?
- Multi-arch ever needed? Staging/prod are amd64 (Phala TDX); single-arch keeps
  reproducibility simplest. Confirm we never deploy arm64.
- Should the reproducibility CI guard **block** merges, or run advisory until
  Phase B converges?
- `config.toml` is copied into the image — confirm it carries no
  environment-specific or secret values that would change the digest per-deploy.
