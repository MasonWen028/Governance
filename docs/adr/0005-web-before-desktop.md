# 5. Web before desktop

Date: 2026-10-13
Status: accepted

## Context

The owner asked for a desktop-grade workbench, with Electron or Tauri named as
eventual targets. The question was whether to start there.

## Decision

Build the web application first and treat a desktop shell as a later layer that
adds no new application code.

## Rationale

The prototype already proved this is a packaging question rather than an
architectural one. Everything the desktop build would need is already true of the
web build: it binds to loopback, it reads the local filesystem, it spawns local
processes, and its UI is plain ESM with no server-side rendering.

Starting in a shell would mean paying the toolchain cost before knowing whether the
product is right, and a native shell also tempts platform code into the wrong
layer. The menu bar is the clearest example: the prototype draws one, and a real
desktop build should hand that job to the OS instead. Keeping the web build as the
baseline keeps that boundary visible.

## Consequences

- File access and process spawning live in the Node server, never in the browser.
  This is what makes the shell a wrapper rather than a rewrite.
- The frontend must not use browser-only APIs that a shell would not provide. No
  service workers, no `localStorage` as a requirement — the i18n core takes an
  injectable storage precisely so a native target can supply its own.
- The prototype's hand-drawn menu bar is a prototype affordance. A desktop build
  replaces it with a native menu; the web build keeps it.
