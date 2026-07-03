// E2E assertion spec for the earnings panel.
// Seeds fake submissions via __ppDev, then asserts the earnings strip, summary
// cards, charts, rate toggles, projections, grouping views, and day-of-week
// bars all render with the expected content. Runs under wdio.visual.conf.js
// (dev build, no login needed).

import { POPUP_URL } from '../helpers/constants.js';

async function clearAll() {
  await browser.executeAsync((done) => {
    if (!window.__ppDev) { done(); return; }
    window.__ppDev.clear().then(done).catch(() => done());
  });
}

async function seed(count) {
  const result = await browser.executeAsync((n, done) => {
    if (!window.__ppDev) { done({ error: 'no __ppDev' }); return; }
    window.__ppDev.seed(n).then((c) => done({ count: c })).catch((e) => done({ error: String(e) }));
  }, count);
  if (result.error) throw new Error(`seed failed: ${result.error}`);
  return result.count;
}

async function mockAuthState() {
  await browser.executeAsync((done) => {
    browser.storage.local
      .set({ syncState: { token_ok: true, token_auth_required: false, token_reason: 'mocked' } })
      .then(done)
      .catch(() => done());
  });
  await browser.pause(100);
}

async function gotoEarnings() {
  await browser.execute(() => {
    const tab = document.querySelector('button[data-tab="earnings"]');
    if (tab) tab.click();
  });
  await browser.pause(600);
}

async function resizeWindow() {
  try {
    await browser.setWindowRect(0, 0, 620, 800);
  } catch {
    try { await browser.setWindowSize(620, 800); } catch { /* ignore */ }
  }
}

describe('Earnings panel assertions', () => {
  before(async () => {
    await browser.url(POPUP_URL);
    await browser.waitUntil(
      async () => browser.execute(() => typeof window.__ppDev?.seed === 'function'),
      { timeout: 10_000, timeoutMsg: '__ppDev.seed not available' },
    );
    await resizeWindow();
  });

  // ── Empty state ──────────────────────────────────────────────

  describe('empty state (0 submissions)', () => {
    before(async () => {
      await clearAll();
      await mockAuthState();
      await browser.url(POPUP_URL);
      await browser.pause(300);
      await gotoEarnings();
    });

    it('shows "No earnings yet" message', async () => {
      const text = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        return panel?.textContent ?? '';
      });
      expect(text).toContain('No earnings yet');
    });

    it('does not render summary cards', async () => {
      const cards = await browser.execute(() =>
        document.querySelectorAll('#panelEarnings .grid.grid-cols-4 > div').length,
      );
      expect(cards).toBe(0);
    });
  });

  // ── With data ────────────────────────────────────────────────

  describe('seeded with 300 submissions', () => {
    before(async () => {
      await clearAll();
      await seed(300);
      await mockAuthState();
      await resizeWindow();
      await browser.url(POPUP_URL);
      await browser.pause(300);
      await gotoEarnings();
    });

    // -- Summary cards --

    it('renders 4 summary cards (Today, 7 days, 30 days, All time)', async () => {
      const labels = await browser.execute(() => {
        const grid = document.querySelector('#panelEarnings .earnings-panel > .grid.grid-cols-4');
        if (!grid) return [];
        const cards = grid.querySelectorAll(':scope > div');
        return [...cards].map((el) => {
          const children = el.querySelectorAll(':scope > div');
          return { label: children[0]?.textContent?.trim(), value: children[1]?.textContent?.trim() };
        });
      });
      expect(labels.length).toBe(4);
      expect(labels[0].label).toBe('Today');
      expect(labels[1].label).toBe('7 days');
      expect(labels[2].label).toBe('30 days');
      expect(labels[3].label).toBe('All time');
    });

    it('All time value is a currency string starting with £', async () => {
      const allTimeValue = await browser.execute(() => {
        const els = document.querySelectorAll('#panelEarnings .grid.grid-cols-4 > div');
        const allTimeCard = els[3];
        return allTimeCard?.querySelectorAll('div')[1]?.textContent?.trim() ?? '';
      });
      expect(allTimeValue).toMatch(/^£[\d,.]+/);
    });

    it('All time value is > £0', async () => {
      const amount = await browser.execute(() => {
        const els = document.querySelectorAll('#panelEarnings .grid.grid-cols-4 > div');
        const allTimeCard = els[3];
        const text = allTimeCard?.querySelectorAll('div')[1]?.textContent?.trim() ?? '£0';
        return parseFloat(text.replace(/[^0-9.]/g, ''));
      });
      expect(amount).toBeGreaterThan(0);
    });

    // -- Sparkline chart --

    it('renders the daily earnings sparkline (SVG with paths)', async () => {
      const svgInfo = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const svg = panel?.querySelector('svg');
        if (!svg) return null;
        return {
          paths: svg.querySelectorAll('path').length,
          width: svg.getBoundingClientRect().width,
        };
      });
      expect(svgInfo).not.toBeNull();
      expect(svgInfo.paths).toBeGreaterThan(0);
      expect(svgInfo.width).toBeGreaterThan(50);
    });

    // -- Money status (composition bar) --

    it('renders the money status composition bar', async () => {
      const segments = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const labels = panel?.querySelectorAll('.earnings-panel .rounded-lg');
        for (const card of labels ?? []) {
          if (card.textContent?.includes('Money status')) {
            const bars = card.querySelectorAll('.rounded-full > div');
            return [...bars].map((b) => b.className);
          }
        }
        return [];
      });
      expect(segments.length).toBeGreaterThan(0);
    });

    it('composition shows Banked, Pending, and Not paid labels', async () => {
      const labels = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const allText = panel?.textContent ?? '';
        return {
          hasBanked: allText.includes('Banked'),
          hasPending: allText.includes('Pending'),
          hasNotPaid: allText.includes('Not paid'),
        };
      });
      expect(labels.hasBanked).toBe(true);
      expect(labels.hasPending).toBe(true);
      expect(labels.hasNotPaid).toBe(true);
    });

    // -- Top researchers --

    it('renders top researchers section with researcher names', async () => {
      const researchers = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const cards = panel?.querySelectorAll('.earnings-panel .rounded-lg');
        for (const card of cards ?? []) {
          if (card.textContent?.includes('Top researchers')) {
            const rows = card.querySelectorAll('.space-y-1 > div');
            return [...rows].map((r) => r.textContent?.trim());
          }
        }
        return [];
      });
      expect(researchers.length).toBeGreaterThan(0);
      expect(researchers.length).toBeLessThanOrEqual(4);
    });

    // -- Best days (day-of-week bars) --

    it('renders day-of-week bar chart with 7 bars', async () => {
      const barCount = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const cards = panel?.querySelectorAll('.earnings-panel .rounded-lg');
        for (const card of cards ?? []) {
          if (card.textContent?.includes('Best days')) {
            return card.querySelectorAll('.flex.items-end.gap-1 > div').length;
          }
        }
        return 0;
      });
      expect(barCount).toBe(7);
    });

    it('day-of-week initials are S M T W T F S', async () => {
      const initials = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const cards = panel?.querySelectorAll('.earnings-panel .rounded-lg');
        for (const card of cards ?? []) {
          if (card.textContent?.includes('Best days')) {
            const rows = card.querySelectorAll('.flex.gap-1');
            const labelRow = rows[rows.length - 1];
            return [...labelRow.querySelectorAll(':scope > div')]
              .map((l) => l.textContent?.trim())
              .filter((t) => t.length > 0);
          }
        }
        return [];
      });
      expect(initials).toEqual(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
    });

    // -- Effective rate section --

    it('renders the effective rate section with rate toggle buttons', async () => {
      const buttons = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const tablist = panel?.querySelector('[role="tablist"]');
        if (!tablist) return [];
        return [...tablist.querySelectorAll('button[role="tab"]')].map((b) => ({
          text: b.textContent?.trim(),
          selected: b.getAttribute('aria-selected'),
        }));
      });
      expect(buttons.length).toBe(3);
      expect(buttons.map((b) => b.text)).toEqual([
        'Per submission',
        'Per hour of work',
        'Per active day',
      ]);
      // Default is "Per hour of work"
      expect(buttons[1].selected).toBe('true');
    });

    it('shows rate stats (Median, Mean, P25, P75)', async () => {
      const labels = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const cards = panel?.querySelectorAll('.earnings-panel .rounded-lg');
        for (const card of cards ?? []) {
          if (card.textContent?.includes('Effective rate')) {
            const statLabels = card.querySelectorAll('.grid.grid-cols-4 span');
            return [...statLabels]
              .map((s) => s.textContent?.trim())
              .filter((t) => ['Median', 'Mean', 'P25', 'P75'].includes(t));
          }
        }
        return [];
      });
      expect(labels).toEqual(['Median', 'Mean', 'P25', 'P75']);
    });

    it('rate values contain /hr suffix', async () => {
      const hasHrSuffix = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const cards = panel?.querySelectorAll('.earnings-panel .rounded-lg');
        for (const card of cards ?? []) {
          if (card.textContent?.includes('Effective rate')) {
            return card.textContent?.includes('/hr');
          }
        }
        return false;
      });
      expect(hasHrSuffix).toBe(true);
    });

    // -- Rate toggle interaction --

    it('clicking "Per submission" toggles the rate method', async () => {
      await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const btn = [...panel.querySelectorAll('button[role="tab"]')].find(
          (b) => b.textContent?.trim() === 'Per submission',
        );
        btn?.click();
      });
      await browser.pause(300);

      const selected = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const btn = [...panel.querySelectorAll('button[role="tab"]')].find(
          (b) => b.textContent?.trim() === 'Per submission',
        );
        return btn?.getAttribute('aria-selected');
      });
      expect(selected).toBe('true');
    });

    it('clicking "Per active day" shows /day suffix', async () => {
      await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const btn = [...panel.querySelectorAll('button[role="tab"]')].find(
          (b) => b.textContent?.trim() === 'Per active day',
        );
        btn?.click();
      });
      await browser.pause(300);

      const hasDaySuffix = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const cards = panel?.querySelectorAll('.earnings-panel .rounded-lg');
        for (const card of cards ?? []) {
          if (card.textContent?.includes('Effective rate')) {
            return card.textContent?.includes('/day');
          }
        }
        return false;
      });
      expect(hasDaySuffix).toBe(true);
    });

    // -- Include pending toggle --

    it('renders the "Include pending" checkbox', async () => {
      const checkbox = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        const labels = panel?.querySelectorAll('label');
        for (const l of labels ?? []) {
          if (l.textContent?.includes('Include pending')) {
            const cb = l.querySelector('input[type="checkbox"]');
            return { exists: true, checked: cb?.checked ?? false };
          }
        }
        return { exists: false };
      });
      expect(checkbox.exists).toBe(true);
    });

    // -- Open full view button --

    it('has an "Open full view" button', async () => {
      const exists = await browser.execute(() => {
        const panel = document.querySelector('#panelEarnings');
        return [...(panel?.querySelectorAll('button') ?? [])].some(
          (b) => b.textContent?.includes('Open full view'),
        );
      });
      expect(exists).toBe(true);
    });
  });

  // -- Earnings strip (on the live panel, shown by default) --

  describe('earnings strip on live panel', () => {
    before(async () => {
      await clearAll();
      await seed(300);
      await mockAuthState();
      await resizeWindow();
      await browser.url(POPUP_URL);
      await browser.pause(400);
    });

    it('renders the earnings strip with period labels', async () => {
      const labels = await browser.execute(() => {
        const strip = document.querySelector('.earnings-strip');
        if (!strip) return [];
        const spans = strip.querySelectorAll('span');
        return [...spans]
          .map((s) => s.textContent?.trim())
          .filter((t) => ['Today', '7d', '30d', 'All time'].includes(t));
      });
      expect(labels).toEqual(['Today', '7d', '30d', 'All time']);
    });

    it('strip All time value is non-zero', async () => {
      const amount = await browser.execute(() => {
        const strip = document.querySelector('.earnings-strip');
        if (!strip) return 0;
        const cols = strip.querySelectorAll('.flex.flex-col');
        for (const col of cols) {
          if (col.textContent?.includes('All time')) {
            const val = col.querySelectorAll('span')[1]?.textContent?.trim() ?? '£0';
            return parseFloat(val.replace(/[^0-9.]/g, ''));
          }
        }
        return 0;
      });
      expect(amount).toBeGreaterThan(0);
    });

    it('strip shows Rate (30d) with /hr suffix', async () => {
      const hasRate = await browser.execute(() => {
        const strip = document.querySelector('.earnings-strip');
        return strip?.textContent?.includes('Rate (30d)') && strip?.textContent?.includes('/hr');
      });
      expect(hasRate).toBe(true);
    });

    it('strip shows Approved count', async () => {
      const hasApproved = await browser.execute(() => {
        const strip = document.querySelector('.earnings-strip');
        return strip?.textContent?.includes('Approved');
      });
      expect(hasApproved).toBe(true);
    });
  });
});
