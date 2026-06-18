#!/usr/bin/env node
'use strict';

// ── LiftLog MCP server ────────────────────────────────────────────────────────
// Exposes your finished workouts (stored in Supabase by the LiftLog PWA) to an
// AI health agent as structured tools. Read-only.
//
// Config via env (see .env.example):
//   LIFTLOG_SUPABASE_URL          e.g. https://ztklvpjydltpytqgleqo.supabase.co
//   LIFTLOG_SUPABASE_SERVICE_KEY  the service_role key (server-side secret)
//   LIFTLOG_USER_ID               (optional) restrict to one user's rows
//
// The service_role key bypasses Row-Level Security — keep it local (.env, never
// committed). This server only ever READS.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Minimal .env loader (no dependency): KEY=VALUE lines next to this file are
// loaded into process.env unless already set. Keeps the service_role key in a
// local gitignored file rather than in Claude's MCP config or anywhere shared.
(function loadDotEnv() {
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* no .env — rely on real env vars */ }
})();

const URL = process.env.LIFTLOG_SUPABASE_URL;
const KEY = process.env.LIFTLOG_SUPABASE_SERVICE_KEY;
const USER_ID = process.env.LIFTLOG_USER_ID || null;

if (!URL || !KEY) {
  console.error('[liftlog-mcp] Missing LIFTLOG_SUPABASE_URL or LIFTLOG_SUPABASE_SERVICE_KEY env vars.');
  process.exit(1);
}

// ── Supabase REST helpers ─────────────────────────────────────────────────────
async function fetchTable(table) {
  let url = `${URL}/rest/v1/${table}?select=id,data,deleted&deleted=eq.false&limit=20000`;
  if (USER_ID) url += `&user_id=eq.${encodeURIComponent(USER_ID)}`;
  const res = await fetch(url, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase ${table} ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows.map(r => r.data).filter(Boolean);
}

// ── Domain helpers ────────────────────────────────────────────────────────────
const epley = (w, r) => (!w || !r) ? 0 : Math.round(w * (1 + r / 30));
const round = n => Math.round(n * 100) / 100;

async function loadAll() {
  const [workouts, sets, exercises] = await Promise.all([
    fetchTable('workouts'), fetchTable('sets'), fetchTable('exercises')
  ]);
  const setsByWorkout = {};
  for (const s of sets) {
    if (!s.done) continue;
    (setsByWorkout[s.workoutId] = setsByWorkout[s.workoutId] || []).push(s);
  }
  for (const k in setsByWorkout) setsByWorkout[k].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const finished = workouts.filter(w => w.finishedAt)
    .sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt));
  return { workouts, finished, sets, setsByWorkout, exercises };
}

function summarizeWorkout(w, setsByWorkout) {
  const sets = setsByWorkout[w.id] || [];
  const vol = sets.reduce((a, s) => a + (s.weight || 0) * (s.reps || 0), 0);
  const prCount = sets.reduce((a, s) => a + (s.prTypes ? s.prTypes.length : 0), 0);
  const durationMin = w.finishedAt && w.startedAt
    ? Math.round((new Date(w.finishedAt) - new Date(w.startedAt)) / 60000) : null;
  const order = (w.exerciseOrder && w.exerciseOrder.length)
    ? w.exerciseOrder
    : [...new Set(sets.map(s => s.exerciseId))];
  const exercises = order.map(exId => {
    const es = sets.filter(s => s.exerciseId === exId);
    if (!es.length) return null;
    return {
      name: es[0].exerciseName || exId,
      sets: es.map(s => ({
        weight_lb: s.weight, reps: s.reps, est_1rm: epley(s.weight, s.reps),
        ...(s.prTypes && s.prTypes.length ? { prs: s.prTypes } : {})
      }))
    };
  }).filter(Boolean);
  return {
    id: w.id, label: w.label || 'Workout', date: w.date || (w.finishedAt || '').slice(0, 10),
    location: w.location || null, finishedAt: w.finishedAt, durationMin,
    totalVolumeLb: round(vol), prCount, exercises
  };
}

const ok = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

// ── Server ────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'liftlog', version: '1.0.0' });

server.tool(
  'list_recent_workouts',
  'List finished workouts, newest first, each with exercises, sets (weight/reps/est 1RM), volume, duration, location, and PR count. Use this to see what was trained recently.',
  { since: z.string().optional().describe('ISO date/time; only workouts finished after this'),
    limit: z.number().int().positive().max(200).optional().describe('max workouts (default 20)') },
  async ({ since, limit }) => {
    const { finished, setsByWorkout } = await loadAll();
    let list = finished;
    if (since) { const t = new Date(since); list = list.filter(w => new Date(w.finishedAt) > t); }
    list = list.slice(0, limit || 20);
    return ok({ count: list.length, workouts: list.map(w => summarizeWorkout(w, setsByWorkout)) });
  }
);

server.tool(
  'get_workout',
  'Get the full detail of one workout by its id (every exercise and set, with est 1RM and PR flags).',
  { workout_id: z.string().describe('the workout id') },
  async ({ workout_id }) => {
    const { finished, workouts, setsByWorkout } = await loadAll();
    const w = workouts.find(x => x.id === workout_id);
    if (!w) return ok({ error: 'workout not found', workout_id });
    return ok(summarizeWorkout(w, setsByWorkout));
  }
);

server.tool(
  'get_exercise_history',
  'Chronological performance for one exercise (matched by name, case-insensitive) — every session with its sets and best est 1RM. Optionally scope to one location, since the same lift at different gyms is not directly comparable.',
  { exercise: z.string().describe('exercise name, e.g. "Smith Bench"'),
    location: z.string().optional().describe('only this location, e.g. "PF Highland Village"'),
    limit: z.number().int().positive().max(200).optional().describe('max sessions (default 30)') },
  async ({ exercise, location, limit }) => {
    const { finished, setsByWorkout } = await loadAll();
    const q = exercise.trim().toLowerCase();
    const out = [];
    for (const w of finished) {
      if (location && w.location !== location) continue;
      const es = (setsByWorkout[w.id] || []).filter(s => (s.exerciseName || '').toLowerCase() === q);
      if (!es.length) continue;
      const best1rm = Math.max(...es.map(s => epley(s.weight, s.reps)));
      out.push({
        date: w.date || (w.finishedAt || '').slice(0, 10), finishedAt: w.finishedAt,
        location: w.location || null, best_est_1rm: best1rm,
        sets: es.map(s => ({ weight_lb: s.weight, reps: s.reps, est_1rm: epley(s.weight, s.reps),
          ...(s.prTypes && s.prTypes.length ? { prs: s.prTypes } : {}) }))
      });
      if (out.length >= (limit || 30)) break;
    }
    return ok({ exercise, location: location || 'all', sessions: out.length, history: out });
  }
);

server.tool(
  'list_exercises',
  'List the exercise library (name, body part, category) the user has defined.',
  {},
  async () => {
    const { exercises } = await loadAll();
    return ok({ count: exercises.length, exercises: exercises
      .map(e => ({ name: e.name, bodyPart: e.bodyPart || null, category: e.category || null }))
      .sort((a, b) => a.name.localeCompare(b.name)) });
  }
);

server.tool(
  'get_personal_records',
  'List sets flagged as personal records (1RM / VOL / WEIGHT), newest first. Optionally filter to one exercise.',
  { exercise: z.string().optional().describe('only this exercise (name, case-insensitive)'),
    limit: z.number().int().positive().max(200).optional() },
  async ({ exercise, limit }) => {
    const { finished, setsByWorkout } = await loadAll();
    const q = exercise ? exercise.trim().toLowerCase() : null;
    const prs = [];
    for (const w of finished) {
      for (const s of (setsByWorkout[w.id] || [])) {
        if (!s.prTypes || !s.prTypes.length) continue;
        if (q && (s.exerciseName || '').toLowerCase() !== q) continue;
        prs.push({ date: w.date || (w.finishedAt || '').slice(0, 10), exercise: s.exerciseName,
          location: w.location || null, weight_lb: s.weight, reps: s.reps,
          est_1rm: epley(s.weight, s.reps), types: s.prTypes });
      }
      if (prs.length >= (limit || 50)) break;
    }
    return ok({ count: prs.length, personal_records: prs });
  }
);

server.tool(
  'get_training_summary',
  'Aggregate training stats over a window: workout count, total volume, sets, and a breakdown of sets per body part. Good for a periodic check-in.',
  { since: z.string().optional().describe('ISO date/time (default: last 30 days)') },
  async ({ since }) => {
    const { finished, setsByWorkout, exercises } = await loadAll();
    const bodyByName = {};
    exercises.forEach(e => { bodyByName[(e.name || '').toLowerCase()] = e.bodyPart || 'Other'; });
    const cut = since ? new Date(since) : new Date(Date.now() - 30 * 864e5);
    const inWin = finished.filter(w => new Date(w.finishedAt) > cut);
    let vol = 0, setCt = 0; const byPart = {}; const byLoc = {};
    for (const w of inWin) {
      byLoc[w.location || 'Unspecified'] = (byLoc[w.location || 'Unspecified'] || 0) + 1;
      for (const s of (setsByWorkout[w.id] || [])) {
        vol += (s.weight || 0) * (s.reps || 0); setCt++;
        const part = bodyByName[(s.exerciseName || '').toLowerCase()] || 'Other';
        byPart[part] = (byPart[part] || 0) + 1;
      }
    }
    return ok({ since: cut.toISOString(), workouts: inWin.length, totalSets: setCt,
      totalVolumeLb: round(vol), setsByBodyPart: byPart, workoutsByLocation: byLoc });
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[liftlog-mcp] ready — 6 tools, reading from ' + URL);
