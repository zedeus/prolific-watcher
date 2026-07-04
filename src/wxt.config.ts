import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  srcDir: '.',
  modules: ['@wxt-dev/module-svelte'],
  manifest: ({ browser }) => ({
    name: 'Prolific Pulse',
    version: '1.3.1',
    description:
      'Real-time study monitoring for Prolific. Get instant alerts when studies matching your criteria become available.',
    icons: {
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '96': 'icons/icon-96.png',
      '128': 'icons/icon-128.png',
    },
    permissions: [
      'scripting',
      'tabs',
      'alarms',
      'storage',
      'webRequest',
      'notifications',
      ...(browser === 'firefox'
        ? ['webRequestBlocking', 'webRequestFilterResponse']
        : ['offscreen']),
    ],
    host_permissions: [
      '*://*.prolific.com/*',
      'https://api.telegram.org/*',
      'https://api.frankfurter.dev/*',
    ],
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; connect-src 'self' https://*.prolific.com https://api.telegram.org https://api.frankfurter.dev;",
    },
    browser_specific_settings:
      browser === 'firefox'
        ? { gecko: { id: '{fae5de21-ec2a-4a34-92ba-d1d2dc76553e}', strict_min_version: '142.0', data_collection_permissions: { required: ['none'] } } }
        : undefined,
    web_accessible_resources: browser === 'chrome' ? [
      { resources: ['intercept-main.js'], matches: ['*://app.prolific.com/*', '*://auth.prolific.com/*'] },
    ] : undefined,
    homepage_url: 'https://github.com/zedeus/prolific-pulse',
  }),
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
