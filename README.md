# LiftLog

A mobile-first PWA for tracking workouts — create your own exercises, log sets/reps/weight,
track PRs, and time your rest. Built for **automated export**: every finished workout syncs to
the cloud so a health agent can read and analyze it without any manual export step.

> Working name. Vanilla JS, no framework, no build step — same stack as the PepBros peptide tracker.

## Status

🚧 Scaffolding only. App not built yet.

## Planned stack

- **Frontend:** Vanilla JS PWA (no build step), mobile-first, Strong-inspired UI.
- **Local store:** IndexedDB (offline working copy).
- **Cloud sync:** Supabase (canonical per-user copy, RLS-protected) — last-write-wins, tombstones.
- **Hosting:** GitHub Pages, auto-deploy from `main`.
- **Agent access:** health agent reads finished workouts directly from Supabase (later: a small MCP).

## Core ideas

- **You define every exercise** (e.g. "Smith Bench") — no fixed catalog.
- **Location is a first-class field** ("PF Highland Village", "Home", "Work") because the same lift
  at a different gym isn't directly comparable. Compare within a location or across, by choice.
- **Start a workout** three ways: empty, from a template, or "perform again" (repeat a past session).
- **Rest timer**, **PR detection** (Epley 1RM), and a fast set-entry session screen.

## License

Personal project. All rights reserved (for now).
