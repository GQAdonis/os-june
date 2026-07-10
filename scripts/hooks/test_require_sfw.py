"""Regression matrix for require-sfw.py. Run: python3 scripts/hooks/test_require_sfw.py"""
import json
import subprocess
import sys

HOOK = sys.argv[1] if len(sys.argv) > 1 else __file__.replace('test_require_sfw.py', 'require-sfw.py')
cases = [
    ("pnpm add lodash", True),
    ("cd foo && pnpm add lodash", True),
    ("CI=true pnpm update", True),
    ("pnpm up", True),
    ("pnpm dlx create-thing", True),
    ("pnpm install some-pkg", True),
    ("cargo add serde", True),
    ("cargo install cargo-edit", True),
    ("cargo update", True),
    ("bun install", True),
    ("yarn add x", True),
    ("npm install lodash", True),
    ("npm ci", True),
    ("sfw pnpm add lodash", False),
    ("sfw cargo add serde", False),
    ("npm i -g sfw", False),
    ("npm install --global pnpm@11", False),
    ("pnpm install", False),
    ("pnpm install --frozen-lockfile", False),
    ("pnpm test", False),
    ("pnpm tauri:dev", False),
    ("cargo build", False),
    ("cargo test --manifest-path src-tauri/Cargo.toml", False),
    ("cargo fetch", False),
    ("git commit -m 'pnpm add docs'", False),
    ("echo pnpm add x", False),
    ("rg -n 'cargo add' spec/", False),
    ("make verify", False),
]
fails = 0
for cmd, expect_blocked in cases:
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    p = subprocess.run(
        ["python3", HOOK], input=payload, capture_output=True, text=True
    )
    blocked = p.returncode == 2
    if blocked != expect_blocked:
        fails += 1
        print(f"FAIL {cmd!r}: blocked={blocked} expected={expect_blocked}")
print(f"{len(cases) - fails}/{len(cases)} cases pass")
sys.exit(1 if fails else 0)
