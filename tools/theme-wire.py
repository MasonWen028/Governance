#!/usr/bin/env python3
"""Apply the Multica-flavored theme layer to web/index.html.

The main wire-web.py patches the pristine prototype one-shot and is not
idempotent, so any replay starts from a page WITHOUT this layer. This script
re-applies it. It is idempotent: run it any number of times, the result is the
same page.

What it does, all three idempotently:

1. Fills the `<style data-theme-layer>` block with tools/theme.css. The empty
   block is part of the page; a block that is already filled is replaced, not
   stacked.
2. Ensures `<script src="theme.js"></script>` sits before `</head>`. The script
   must run before first paint, or the page flashes light before going dark.
3. Ensures renderMenubar carries the theme chip (markup + handler), the same
   edit this repo's passes made by hand.

Run from the repository root:  python tools/theme-wire.py
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAGE = os.path.join(ROOT, 'web', 'index.html')
THEME_CSS = os.path.join(HERE, 'theme.css')

THEME_SCRIPT = '<script src="theme.js"></script>'

CHIP_MARKUP_OLD = (
    "'<span class=\"langchip\" id=\"langChip\">'+I18N.meta().short+'</span>'+"
)
CHIP_MARKUP_NEW = (
    "'<span class=\"langchip\" id=\"themeChip\" title=\"Theme / \u4e3b\u9898\">'"
    "+(window.ThemeUI?window.ThemeUI.label():'')+'</span>'+"
    "\n      " + CHIP_MARKUP_OLD
)

CHIP_HANDLER_OLD = """  if(openIdx!==null)openMenuAt(openIdx);
}"""
CHIP_HANDLER_NEW = """  const tchip=document.getElementById('themeChip');
  if(tchip)tchip.onclick=e=>{
    e.stopPropagation();
    window.ThemeUI.next();renderAll();
    toast('Theme / \u4e3b\u9898: '+window.ThemeUI.label());
  };
  if(openIdx!==null)openMenuAt(openIdx);
}"""


def fill_style_block(src: str, css: str) -> str:
    """Fill or replace the <style data-theme-layer> block."""
    pat = re.compile(
        r'<style data-theme-layer>.*?</style>', re.DOTALL)
    body = (
        '<style data-theme-layer>\n'
        '/* Injected by tools/theme-wire.py from tools/theme.css. Idempotent: re-running\n'
        '   the injector replaces this block instead of stacking a second copy. */\n'
        + css.strip() + '\n</style>'
    )
    if pat.search(src):
        return pat.sub(lambda _: body, src, count=1)
    # No block yet (a replay from the prototype): insert one before </head>.
    if '</head>' not in src:
        raise SystemExit('no </head> to insert the theme layer before')
    return src.replace('</head>', body + '\n</head>', 1)


def ensure_theme_script(src: str) -> str:
    if THEME_SCRIPT in src:
        return src
    if '</head>' not in src:
        raise SystemExit('no </head> to insert theme.js before')
    return src.replace('</head>', THEME_SCRIPT + '\n</head>', 1)


def ensure_chip(src: str) -> str:
    """Idempotent by construction: each step checks for its own output first."""
    if 'id="themeChip"' not in src:
        if CHIP_MARKUP_OLD not in src:
            raise SystemExit('theme chip: langChip markup anchor not found')
        src = src.replace(CHIP_MARKUP_OLD, CHIP_MARKUP_NEW, 1)
    if 'tchip.onclick' not in src:
        if CHIP_HANDLER_OLD not in src:
            raise SystemExit('theme chip: renderMenubar tail anchor not found')
        src = src.replace(CHIP_HANDLER_OLD, CHIP_HANDLER_NEW, 1)
    return src


def main() -> int:
    with io.open(PAGE, encoding='utf-8') as f:
        src = f.read()
    with io.open(THEME_CSS, encoding='utf-8') as f:
        css = f.read()

    out = ensure_chip(ensure_theme_script(fill_style_block(src, css)))

    if out != src:
        with io.open(PAGE, 'w', encoding='utf-8') as f:
            f.write(out)
        print(f'theme layer applied to {PAGE} ({len(src)} -> {len(out)} bytes)')
    else:
        print(f'{PAGE} already carries the theme layer')
    return 0


if __name__ == '__main__':
    sys.exit(main())
