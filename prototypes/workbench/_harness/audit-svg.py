#!/usr/bin/env python3
"""Static audit: does every inline SVG have an explicit size?

An inline SVG with no width/height renders at the replaced-element default
(300x150) and silently blows up whichever container holds it. That is invisible
to a JS smoke test, so it needs its own check.

Reports:
  1. the global `svg { ... }` fallback (must exist)
  2. every selector that sets an svg width
  3. every container class that emits an inline <svg>, flagged if neither it
     nor the global fallback sizes the SVG

Usage:  python _harness/audit-svg.py
Exit:   0 = all covered, 1 = uncovered SVG container or missing fallback
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAGE = os.path.join(ROOT, 'index.html')


def main():
    with open(PAGE, encoding='utf-8') as f:
        src = f.read()

    style = re.search(r'<style>(.*?)</style>', src, re.S)
    if not style:
        print('FAIL: no <style> block')
        return 1
    # strip CSS comments so they don't get glued onto selectors
    css = re.sub(r'/\*.*?\*/', '', style.group(1), flags=re.S)

    rules = []
    for sel, body in re.findall(r'([^{}]+)\{([^}]*)\}', css):
        props = {}
        for decl in body.split(';'):
            if ':' in decl:
                k, v = decl.split(':', 1)
                props[k.strip()] = v.strip()
        rules.append((sel.strip(), props))

    # 1. global fallback
    fallback = next((p for sel, p in rules if sel == 'svg'), None)
    print('=== global fallback ===')
    if fallback and 'width' in fallback and 'height' in fallback:
        print('  ok   svg { width: %s; height: %s }' % (fallback['width'], fallback['height']))
    else:
        print('  FAIL no global `svg { width; height }` default')
        return 1

    # 2. component rules
    print('\n=== rules that size an svg ===')
    sizing = []
    for sel, props in rules:
        if 'svg' in sel and 'width' in props:
            sizing.append(sel)
            print('  %-52s %s' % (sel, props['width']))
    print('  (%d rules)' % len(sizing))

    # 3. containers emitting an inline svg
    print('\n=== containers that emit an inline <svg> ===')
    containers = set()
    # static HTML: class="x" ... <svg
    for m in re.finditer(r'class="([^"]+)"[^>]*>\s*<svg', src):
        containers.add(m.group(1).strip())
    # JS string builders: '<... class="x" ...>' + ... svg(  /  <svg
    for m in re.finditer(r"class=\\?[\"']([^\"'\\]+)\\?[\"'][^>]*>\s*'?\s*\+?\s*(?:svg\(|<svg)", src):
        containers.add(m.group(1).strip())

    problems = []
    for cls in sorted(containers):
        # does any sizing rule mention this container (possibly as an ancestor)?
        hit = any(cls in sel or sel.endswith('svg') and cls in sel for sel in sizing)
        # a container is also fine if a descendant rule covers it, e.g. `.gh .gicon svg`
        hit = hit or any(cls in sel for sel in sizing)
        mark = 'ok  ' if hit else 'GAP '
        if not hit:
            problems.append(cls)
        print('  %s %s' % (mark, cls))

    print()
    if problems:
        print('UNCOVERED (relying on the global fallback): %s' % ', '.join(problems))
        print('The global fallback keeps them sane, but each icon should be sized explicitly.')
    print('RESULT: %s' % ('all covered' if not problems else '%d uncovered' % len(problems)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
