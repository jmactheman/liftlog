'use strict';

// ── LiftLog · Supabase auth ───────────────────────────────────────────────────
// DORMANT until you fill in the two values below. While they hold the PLACEHOLDER
// strings, the app runs purely local (IndexedDB) — sign-in UI shows a friendly
// "not configured" note and nothing tries to reach the network.
//
// To turn cloud sync ON (see SUPABASE_SETUP.md):
//   1. Create a Supabase project, run SUPABASE_SETUP.sql in its SQL editor.
//   2. Paste your project URL + publishable (anon) key below.
//   3. Allowlist this app's URL under Auth → URL Configuration.
// The anon key is MEANT to be public — Row-Level Security protects user data.
// NEVER put the secret key here.
var SUPABASE_URL = 'YOUR_SUPABASE_URL';
var SUPABASE_KEY = 'YOUR_SUPABASE_ANON_KEY';

var sb       = null;
var authUser = null;

function syncConfigured() {
  return SUPABASE_URL.indexOf('http') === 0 && SUPABASE_KEY && SUPABASE_KEY.indexOf('YOUR_') !== 0;
}
function authReady()  { return !!sb; }
function currentUser() { return authUser; }

function initAuth() {
  if (!syncConfigured()) { renderAccountUI(); renderAccountStrip(); return; }
  if (typeof supabase === 'undefined' || !supabase.createClient) {
    console.warn('[auth] Supabase library unavailable — running local-only.');
    renderAccountUI(); renderAccountStrip(); return;
  }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  sb.auth.getSession().then(function(res) {
    authUser = (res && res.data && res.data.session) ? res.data.session.user : null;
    renderAccountUI(); renderAccountStrip();
  }).catch(function(e) { console.warn('[auth] getSession failed:', e && e.message); renderAccountUI(); renderAccountStrip(); });
  sb.auth.onAuthStateChange(function(event, session) {
    authUser = session ? session.user : null;
    renderAccountUI(); renderAccountStrip();
    if (authUser) closeSignInSheet();
    if (session && typeof onAuthReady === 'function') {
      try { onAuthReady(authUser, event); } catch (e) { console.warn('[auth] onAuthReady error', e); }
    }
  });
}

function redirectURL() { return window.location.href.split('#')[0].split('?')[0]; }

async function sendMagicLink(inputId, msgId, btnId) {
  var msgEl = msgId ? document.getElementById(msgId) : null;
  function msg(t) { if (msgEl) msgEl.textContent = t; }
  if (!authReady()) { msg('Sign-in unavailable right now.'); return; }
  var input = document.getElementById(inputId);
  var email = input ? (input.value || '').trim() : '';
  if (!email) { msg('Enter your email first.'); return; }
  var btn = btnId ? document.getElementById(btnId) : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    var res = await sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: redirectURL() } });
    if (res.error) throw res.error;
    msg('✅ Check your email for a sign-in link.');
  } catch (e) { msg('Error: ' + (e && e.message ? e.message : 'could not send link')); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Send magic link'; } }
}
function signInWithMagicLink() { return sendMagicLink('auth-email', 'auth-msg', 'auth-magic-btn'); }
function sheetMagic()          { return sendMagicLink('sheet-email', 'sheet-msg', 'sheet-magic-btn'); }

async function signInWithGoogle() {
  if (!authReady()) { setAuthMsg('Sign-in unavailable right now.'); return; }
  try {
    var res = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectURL() } });
    if (res.error) throw res.error;
  } catch (e) { setAuthMsg('Error: ' + (e && e.message ? e.message : 'Google sign-in failed')); }
}
async function signOutUser() {
  if (!authReady()) return;
  try { await sb.auth.signOut(); } catch (e) {}
  authUser = null; renderAccountUI();
}
function setAuthMsg(text) { var el = document.getElementById('auth-msg'); if (el) el.textContent = text; }

function renderAccountStrip() {
  var strip = document.getElementById('account-strip'); if (!strip) return;
  if (!syncConfigured() || authUser) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  strip.innerHTML = '<span class="as-text">🔒 Not backed up — your data only lives on this device.</span>' +
    '<button class="btn btn-small" style="width:auto;" onclick="openSignInSheet()">Sign in</button>';
}

function openSignInSheet() {
  document.getElementById('signin-body').innerHTML =
    '<div class="sheet-grab"></div><h2>Back up your workouts</h2>' +
    '<p class="sub">Sign in so finished workouts sync to the cloud for your health agent. The app works without an account too.</p>' +
    '<button class="btn auth-google btn-dark" onclick="signInWithGoogle()">Continue with Google</button>' +
    '<div class="auth-or"><span>or email magic link</span></div>' +
    '<input type="email" id="sheet-email" placeholder="you@email.com" inputmode="email" autocomplete="email">' +
    '<div class="sheet-actions"><button class="btn" id="sheet-magic-btn" onclick="sheetMagic()">Send magic link</button>' +
    '<p class="auth-msg muted tiny" id="sheet-msg"></p>' +
    '<button class="btn btn-dark" onclick="closeSignInSheet()">Not now</button></div>';
  var m = document.getElementById('signin-sheet'); if (m) m.classList.add('active');
  setTimeout(function() { var i = document.getElementById('sheet-email'); if (i) i.focus(); }, 50);
}
function closeSignInSheet() { if (typeof closeModal === 'function') closeModal('signin-sheet'); }

function renderAccountUI() {
  var box = document.getElementById('account-box'); if (!box) return;
  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s) { return s; };
  if (!syncConfigured()) {
    box.innerHTML = '<p class="auth-sub">☁️ Cloud sync isn\'t set up yet. The app works fully on this device. ' +
      'See <strong>SUPABASE_SETUP.md</strong> to enable backup + agent access.</p>';
    return;
  }
  if (!authReady()) { box.innerHTML = '<p class="auth-sub">⚠️ Sync unavailable right now (offline or blocked). The app works normally on this device.</p>'; return; }
  if (authUser) {
    var email = authUser.email || (authUser.user_metadata && authUser.user_metadata.email) || 'your account';
    box.innerHTML = '<p class="auth-status">✅ Signed in as <strong>' + esc(email) + '</strong></p>' +
      '<p class="auth-sub" id="sync-status">Your workouts back up to this account.</p>' +
      '<div class="auth-row"><button class="btn-ghost btn-small" onclick="forceSync()">⟳ Sync now</button>' +
      '<button class="btn-ghost btn-small" onclick="signOutUser()">Sign out</button></div>';
  } else {
    box.innerHTML = '<p class="auth-sub">Sign in to back up your data and sync across devices.</p>' +
      '<div class="auth-row"><input type="email" id="auth-email" placeholder="you@email.com" inputmode="email" autocomplete="email">' +
      '<button class="btn btn-small" style="width:auto;" id="auth-magic-btn" onclick="signInWithMagicLink()">Send magic link</button></div>' +
      '<div class="auth-or"><span>or</span></div>' +
      '<button class="btn btn-dark auth-google" onclick="signInWithGoogle()">Continue with Google</button>' +
      '<p class="auth-msg muted tiny" id="auth-msg"></p>';
  }
}

initAuth();
