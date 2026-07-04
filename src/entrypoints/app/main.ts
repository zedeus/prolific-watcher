import { mount } from 'svelte';
import '../../assets/app.css';
import App from './App.svelte';

// Guard side-effects to this page (see popup/main.ts) so this entry can't mount
// onto popup.html if Vite hoists it into a shared chunk.
if (window.location.pathname.endsWith('/app.html')) {
  // Dev helpers (fake-data seed/clear) only attach in development builds.
  // Wiping a user's real submissions from prod devtools would be a disaster.
  if (import.meta.env.DEV) {
    import('../../lib/__dev__/dev-helpers').then((m) => m.attachDevHelpers());
  }

  mount(App, { target: document.getElementById('app')! });
}
