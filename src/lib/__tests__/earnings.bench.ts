import { bench, describe } from 'vitest';
import { generateFakeSubmissions } from '../__dev__/fake-submissions';
import {
  filterEligible,
  computeTotals,
  dailyRollups,
  perHourOfWorkDaily,
  perSubmissionHourlySeries,
  summarizeRates,
  groupByDayOfWeek,
  groupByResearcher,
  groupByStudy,
  computeStatusComposition,
  detectDefaultCurrency,
  convertRewards,
} from '../earnings';

const NOW = new Date('2026-06-15T12:00:00Z');
const subs10k = generateFakeSubmissions({ count: 10_000, seed: 1, now: NOW });
const subs25k = generateFakeSubmissions({ count: 25_000, seed: 2, now: NOW });

const currency10k = detectDefaultCurrency(subs10k)!;
const currency25k = detectDefaultCurrency(subs25k)!;

const eligible10k = filterEligible(subs10k, { includeStatus: 'approved_and_pending', currency: currency10k });
const eligible25k = filterEligible(subs25k, { includeStatus: 'approved_and_pending', currency: currency25k });

describe('earnings rollups — 10k submissions', () => {
  bench('filterEligible', () => {
    filterEligible(subs10k, { includeStatus: 'approved_and_pending', currency: currency10k });
  });

  bench('computeTotals', () => {
    computeTotals(eligible10k, currency10k);
  });

  bench('dailyRollups', () => {
    dailyRollups(eligible10k);
  });

  bench('perHourOfWorkDaily', () => {
    perHourOfWorkDaily(eligible10k);
  });

  bench('perSubmissionHourlySeries', () => {
    perSubmissionHourlySeries(eligible10k);
  });

  bench('summarizeRates (per-hour-of-work)', () => {
    summarizeRates(perHourOfWorkDaily(eligible10k));
  });

  bench('groupByDayOfWeek', () => {
    groupByDayOfWeek(eligible10k);
  });

  bench('groupByResearcher', () => {
    groupByResearcher(eligible10k);
  });

  bench('groupByStudy', () => {
    groupByStudy(eligible10k);
  });

  bench('computeStatusComposition', () => {
    computeStatusComposition(eligible10k, currency10k);
  });

  bench('convertRewards', () => {
    convertRewards(subs10k, 'GBP', { USD: 0.79, EUR: 0.86 });
  });
});

describe('earnings rollups — 25k submissions', () => {
  bench('filterEligible', () => {
    filterEligible(subs25k, { includeStatus: 'approved_and_pending', currency: currency25k });
  });

  bench('dailyRollups', () => {
    dailyRollups(eligible25k);
  });

  bench('summarizeRates (per-hour-of-work)', () => {
    summarizeRates(perHourOfWorkDaily(eligible25k));
  });

  bench('groupByResearcher', () => {
    groupByResearcher(eligible25k);
  });
});
