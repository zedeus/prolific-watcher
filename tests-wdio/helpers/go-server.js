import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT, GO_SERVER_URL } from './constants.js';

const BINARY_PATH = path.join(PROJECT_ROOT, 'prolific_watcher');

export class GoServerManager {
  constructor() {
    this.process = null;
    this.url = GO_SERVER_URL;
  }

  build() {
    execSync('go build -o prolific_watcher .', {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
    });
  }

  start() {
    if (this.process && this.process.exitCode === null) return;
    this.process = spawn(BINARY_PATH, [], {
      cwd: PROJECT_ROOT,
      stdio: 'ignore',
      detached: false,
    });
    this.process.on('error', (err) => {
      console.error('Go server error:', err.message);
    });
  }

  async stop() {
    if (!this.process) return;
    const proc = this.process;
    this.process = null;
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        resolve();
      }, 5000);
      proc.on('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  async waitHealthy(timeout = 10_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Go server did not become healthy within ${timeout}ms`);
  }

  async isHealthy() {
    try {
      const resp = await fetch(`${this.url}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
