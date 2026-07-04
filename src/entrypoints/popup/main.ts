import { mount } from 'svelte';
import '../../assets/app.css';
import App from './App.svelte';

// Guard side-effects to this page. Vite can hoist an entry module into a chunk
// another page loads (e.g. app.html dynamically imports dev-helpers, which may
// pull this chunk in) — without the guard the popup would mount a second time
// onto app.html. Keying on the pathname keeps each entry to its own page.
if (window.location.pathname.endsWith('/popup.html')) {
  if (import.meta.env.DEV) {
    import('../../lib/__dev__/dev-helpers').then((m) => m.attachDevHelpers());
  }

  document.body.classList.add('no-scroll');
  mount(App, { target: document.getElementById('app')! });
}
