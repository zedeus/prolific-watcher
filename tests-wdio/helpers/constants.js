import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const EXTENSION_DIR = path.join(PROJECT_ROOT, 'localstorage-extension');
export const PROFILE_DIR = path.join(PROJECT_ROOT, 'tests', 'profiles', 'prolific');
export const ADDON_ID = 'localstorage-viewer@prolific-watcher';
export const ADDON_UUID = 'a1b2c3d4-0000-4000-8000-000000000001';
export const GO_SERVER_URL = 'http://localhost:8080';
export const PROLIFIC_APP_URL = 'https://app.prolific.com';
export const PROLIFIC_STUDIES_URL = `${PROLIFIC_APP_URL}/studies`;
export const PROLIFIC_AUTH_HOST = 'auth.prolific.com';
export const AUTH_FILE = path.join(PROJECT_ROOT, '.prolific-auth');
export const POPUP_URL = `moz-extension://${ADDON_UUID}/popup.html`;

export const FIREFOX_PREFS = {
  'xpinstall.signatures.required': false,
  'extensions.autoDisableScopes': 0,
  'extensions.enabledScopes': 15,
  'extensions.webextensions.uuids': JSON.stringify({
    [ADDON_ID]: ADDON_UUID,
  }),
};
