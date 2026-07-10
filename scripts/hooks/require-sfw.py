#!/usr/bin/env python3
"""PreToolUse hook: route new-package installs through Socket Firewall (sfw).

Blocks Bash commands that pull new package code into the repo (pnpm
add/update/dlx, cargo add/install/update) unless prefixed with `sfw`, and
blocks non-pnpm JS package managers entirely. Guardrail, not a sandbox:
anchored per-segment matching keeps false positives low but a determined
command can slip past — the authoritative rule is
spec/package-install-security.md.
"""

import json
import re
import shlex
import sys

PNPM_GUARDED = re.compile(r"^pnpm\s+(add|update|up|dlx)\b")
# `pnpm install <pkg>` resolves a new package; a bare/flag-only install does not.
PNPM_INSTALL = re.compile(r"^pnpm\s+(i|install)\b(.*)$")
CARGO_GUARDED = re.compile(r"^cargo\s+(add|install|update)\b")
# npx / npm exec download and run registry code that never touches a lockfile.
NPX_GUARDED = re.compile(r"^(npx|npm\s+exec)\b")
WRONG_PM = re.compile(r"^(bun|bunx|yarn)\s+(add|install|remove|update|upgrade|\S+)\b")
NPM_INSTALL_COMMANDS = {"i", "install", "ci", "add"}
NPM_GLOBAL_FLAGS = {"-g", "--global", "--location=global"}


def pnpm_install_with_package(seg):
    m = PNPM_INSTALL.match(seg)
    if not m:
        return False
    # Any non-flag token means a package argument (a flag value like
    # `--filter web` also matches — over-blocking is fine for a guardrail,
    # and the sfw prefix is harmless on a plain restore).
    return any(not tok.startswith("-") for tok in m.group(2).split())


def pnpm_audit_fix(seg):
    return bool(
        re.match(r"^pnpm\s+audit\b", seg)
        and re.search(r"(?:^|\s)--fix(?:=\S+)?(?:\s|$)", seg)
    )


def npm_install(seg):
    try:
        tokens = shlex.split(seg)
    except ValueError:
        return None
    if len(tokens) < 2 or tokens[0] != "npm" or tokens[1] not in NPM_INSTALL_COMMANDS:
        return None
    global_install = any(token in NPM_GLOBAL_FLAGS for token in tokens[2:])
    packages = [token for token in tokens[2:] if not token.startswith("-")]
    return global_install, packages


def is_sfw_bootstrap(global_install, packages):
    return global_install and len(packages) == 1 and re.fullmatch(
        r"sfw(?:@[^\s]+)?", packages[0]
    )


def check(command):
    # Backslash-newline continues a command across lines; collapse it so the
    # newline split below cannot break one command into non-matching pieces.
    command = re.sub(r"\\\r?\n\s*", " ", command)
    # Separators and substitution openers ($(, `, <(, >() all start a new
    # segment, so a guarded command nested inside them still hits the
    # anchored patterns below.
    for raw in re.split(r"&&|\|\||;|\||&|[\n\r]+|\$\(|`|[<>]\(", command):
        seg = re.sub(r"^(?:\w+=\S*\s+)+", "", raw.strip())
        wrapped = seg.startswith("sfw ")
        inner = seg[4:].lstrip() if wrapped else seg
        if WRONG_PM.match(inner):
            return (
                "This repo is pnpm-only (no bun/npm/yarn lockfiles). Use "
                "`sfw pnpm add <pkg>` instead; see spec/package-install-security.md."
            )
        npm = npm_install(inner)
        if npm:
            global_install, packages = npm
            if not global_install:
                return (
                    "This repo is pnpm-only (no bun/npm/yarn lockfiles). Use "
                    "`sfw pnpm add <pkg>` instead; see "
                    "spec/package-install-security.md."
                )
            if not wrapped and not is_sfw_bootstrap(global_install, packages):
                return (
                    "Global npm installs must go through Socket Firewall: rerun as "
                    f"`sfw {inner}`. The one-time `npm i -g sfw` bootstrap is "
                    "the only exception; see spec/package-install-security.md."
                )
        if (
            PNPM_GUARDED.match(inner)
            or pnpm_install_with_package(inner)
            or pnpm_audit_fix(inner)
            or CARGO_GUARDED.match(inner)
            or NPX_GUARDED.match(inner)
        ) and not wrapped:
            return (
                "New-package installs must go through Socket Firewall: rerun as "
                f"`sfw {inner}` (one-time setup: `npm i -g sfw`). See "
                "spec/package-install-security.md."
            )
    return None


def main():
    try:
        payload = json.load(sys.stdin)
        command = payload.get("tool_input", {}).get("command", "")
    except Exception:
        return 0
    if not isinstance(command, str) or not command:
        return 0
    message = check(command)
    if message:
        print(message, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
