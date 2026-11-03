#!/usr/bin/env python3
"""Smoke-test the workbench prototype without a browser.

Runs two gates:

  1. Static CSS audit (audit-svg.py) — every inline SVG must have an explicit
     size, otherwise it renders at the 300x150 replaced-element default and
     silently blows up its container. Invisible to a JS test.
  2. DOM smoke test — bundles the i18n core + a DOM shim + the <script> body
     extracted from index.html + the assertions, then runs the bundle under
     node. Catches runtime errors static checks cannot: typos in property
     names, undefined helpers, broken render paths, action dispatch falling
     through, missing translation keys.

Usage:  python _harness/run-smoke.py
Exit:   0 = all assertions passed, 1 = failures or harness error
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAGE = os.path.join(ROOT, 'index.html')
I18N = os.path.join(ROOT, 'i18n.js')

NODE_CANDIDATES = [
    r'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe',
    r'C:\nvm4w\nodejs\node.exe',
    'node',
]


def find_node():
    for c in NODE_CANDIDATES:
        if c == 'node' or os.path.exists(c):
            return c
    return 'node'


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def static_gates():
    """Run the Python-side static audits. Returns 0 on success."""
    audit = os.path.join(HERE, 'audit-svg.py')
    if not os.path.exists(audit):
        return 0
    print('### static: SVG sizing audit')
    proc = subprocess.run([sys.executable, audit], cwd=ROOT,
                          capture_output=True, text=True, encoding='utf-8')
    sys.stdout.write(proc.stdout)
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    print('')
    return proc.returncode


def main():
    rc = static_gates()

    html = read(PAGE)
    blocks = re.findall(r'<script>(.*?)</script>', html, re.S)
    if not blocks:
        print('FAIL: no inline <script> block found in index.html')
        return 1
    body = blocks[-1]
    # Drop the trailing bootstrap so the assertions control execution order.
    body = re.sub(r'\nrenderAll\(\);\s*$', '\n', body)

    if 'src="i18n.js"' not in html:
        print('FAIL: index.html does not load i18n.js')
        return 1

    bundle = '\n'.join([
        read(I18N),
        read(os.path.join(HERE, '_shim.js')),
        body,
        read(os.path.join(HERE, '_test.js')),
    ])
    out = os.path.join(ROOT, '_smoke.js')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(bundle)

    print('### dynamic: DOM smoke test')
    try:
        proc = subprocess.run([find_node(), out], cwd=ROOT,
                              capture_output=True, text=True, encoding='utf-8')
        sys.stdout.write(proc.stdout)
        if proc.stderr:
            sys.stderr.write(proc.stderr)
        if proc.returncode != 0:
            return proc.returncode
    finally:
        if os.path.exists(out):
            os.remove(out)
    return rc


if __name__ == '__main__':
    sys.exit(main())


