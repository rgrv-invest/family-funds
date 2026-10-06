// Entry point for the live app: Google sign-in, access check, then the app.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig, OWNER_EMAIL } from './config.js';
import { createStore } from './firebase-store.js';
import { start, toast } from './app.js';
import { esc } from './format.js';

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

const gate = document.getElementById('gate');
const app = document.querySelector('.app');

function showGate(html) {
  app.hidden = true;
  gate.hidden = false;
  gate.innerHTML = `<div class="gate-card"><div class="brand"><div class="brand-mark">₹</div>Family Funds</div>${html}</div>`;
}

const signInScreen = (msg = '') => showGate(`
  <p class="gate-text">Sign in with the Google account your family admin added to the tracker.</p>
  ${msg ? `<p class="gate-error">${esc(msg)}</p>` : ''}
  <button class="btn primary gate-btn" id="signin">Sign in with Google</button>`);

const noAccessScreen = (email) => showGate(`
  <p class="gate-text"><b>${esc(email)}</b> doesn’t have access to this tracker yet.</p>
  <p class="gate-text muted">Ask the admin to add this address on the Access page, then sign in again.</p>
  <button class="btn gate-btn" id="signout">Use a different account</button>`);

gate.addEventListener('click', async (e) => {
  if (e.target.id === 'signin') {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
        signInScreen(err.code === 'auth/popup-blocked'
          ? 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.'
          : `Sign-in didn’t work (${err.code || err.message}). Try again.`);
      }
    }
  }
  if (e.target.id === 'signout') signOut(auth);
});

let started = false;
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    if (started) location.reload();
    return signInScreen();
  }
  if (started) return;
  const email = (user.email || '').toLowerCase();
  let role = null;
  if (email === OWNER_EMAIL) role = 'admin';
  else {
    try {
      const snap = await getDoc(doc(db, 'users', email));
      role = snap.exists() ? snap.data().role : null;
    } catch { role = null; }
  }
  if (!role) return noAccessScreen(email);

  started = true;
  gate.hidden = true;
  app.hidden = false;
  const store = createStore(db, {
    canEdit: role !== 'viewer',
    isAdmin: role === 'admin',
    onError: (err) => { console.error(err); toast(`Couldn’t save that change: ${err.message || err}`); },
    onDenied: () => { started = false; noAccessScreen(email); },
  });
  start(store, {
    email,
    name: user.displayName || email,
    role,
    owner: OWNER_EMAIL,
    signOut: () => signOut(auth),
  });
});
