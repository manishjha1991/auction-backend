const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeRecord,
  countForTeam,
} = require('../utils/teamCareerStats');

function match(overrides) {
  return {
    sourceId: 'match-1',
    team1: 'Team A',
    team2: 'Team B',
    date: new Date('2026-07-18T10:00:00Z'),
    winnerRaw: 'Team A',
    source: 'tournament_wc',
    priority: 3,
    ...overrides,
  };
}

test('career aggregation preserves distinct same-day rematches', () => {
  const merged = new Map();

  mergeRecord(merged, 'cpl_20', match({ sourceId: 'group-match' }));
  mergeRecord(merged, 'cpl_20', match({
    sourceId: 'final-rematch',
    date: new Date('2026-07-18T20:00:00Z'),
    winnerRaw: 'Team B',
  }));

  assert.deepEqual(countForTeam(merged, 'Team A'), { played: 2, wins: 1 });
  assert.deepEqual(countForTeam(merged, 'Team B'), { played: 2, wins: 1 });
});

test('career aggregation still deduplicates repeated source records', () => {
  const merged = new Map();
  const sameMatch = match({ sourceId: 'same-match' });

  mergeRecord(merged, 'cpl_20', sameMatch);
  mergeRecord(merged, 'cpl_20', { ...sameMatch });

  assert.deepEqual(countForTeam(merged, 'Team A'), { played: 1, wins: 1 });
});

test('higher-priority sources replace lower-priority same-day records', () => {
  const merged = new Map();

  mergeRecord(merged, 'cpl_20', match({ sourceId: 'tournament-copy-1' }));
  mergeRecord(merged, 'cpl_20', match({ sourceId: 'tournament-copy-2' }));
  mergeRecord(merged, 'cpl_20', match({
    sourceId: 'canonical-fixture',
    source: 'fixture',
    priority: 0,
  }));

  assert.deepEqual(countForTeam(merged, 'Team A'), { played: 1, wins: 1 });
});
