import archiver from 'archiver';
import { EXTENSION_DIR } from './constants.js';

/**
 * Zip the extension directory and return it as a base64 string
 * for use with browser.installAddOn().
 */
export async function zipExtensionBase64() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 1 } });

    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => {
      const buf = Buffer.concat(chunks);
      resolve(buf.toString('base64'));
    });
    archive.on('error', reject);

    archive.directory(EXTENSION_DIR, false);
    archive.finalize();
  });
}
