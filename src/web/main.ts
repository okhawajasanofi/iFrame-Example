import './loader'; // defines window.platform for injected child frames
import { on } from './events';
import { restore, currentUser } from './session';
import { showLogin } from './views/login';
import { showShell } from './views/shell';
import { closeAll } from './workspace';

const root = document.getElementById('app')!;

function signedOut(notice?: string) {
  closeAll();
  showLogin(root, (u) => showShell(root, u, () => signedOut()), notice);
}

on('session-expired', () => signedOut('Session expired, sign in again'));

// Reload-safe: the access token lives in memory only, so on load we ask the refresh cookie for a new one.
restore().then((u) => (u ? showShell(root, currentUser()!, () => signedOut()) : signedOut()));
