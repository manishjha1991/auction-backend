const express = require('express');
const axios = require('axios');
const router = express.Router();

// Simple in-memory cache to reduce API calls
let cache = { at: 0, data: [] };
const CACHE_MS = 30 * 1000; // 30 seconds

router.get('/', async (_req, res) => {
  try {
    const now = Date.now();
    if (now - cache.at < CACHE_MS && cache.data && cache.data.length) {
      return res.json({ items: cache.data, cached: true });
    }

    const apiKey = "3b708962-7508-4106-ac3e-8ddac26954da" || '';
    if (!apiKey) {
      // Graceful fallback if no key set
      const demo = [{
        id: 'demo-1',
        series: 'Demo Cup',
        teams: ['Team A', 'Team B'],
        matchType: 'T20',
        status: 'Set CRICAPI_KEY in .env to enable live scores',
        score: '—',
        startsAt: null
      }];
      cache = { at: now, data: demo };
      return res.json({ items: demo, cached: false });
    }

    // Free tier endpoint (subject to provider limits). Replace if you prefer another provider.
    const url = `https://api.cricapi.com/v1/currentMatches?apikey=${encodeURIComponent(apiKey)}&offset=0`;
    const r = await axios.get(url, { timeout: 10000 });
    const raw = (r.data && r.data.data) || [];
    const isIdLike = (str) => {
      if (!str || typeof str !== 'string') return false;
      const s = str.trim();
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (uuid.test(s)) return true;
      if (s.length > 30 && /^[A-Za-z0-9_-]+$/.test(s)) return true;
      return false;
    };
    const friendlySeries = (m) => {
      const candidates = [m.series?.name, m.series, m.name, m.venue].filter(Boolean);
      for (const c of candidates) {
        if (typeof c === 'string' && !isIdLike(c) && c.trim().length >= 3) return c.trim();
      }
      return 'Cricket';
    };
    const items = raw.slice(0, 8).map((m) => ({
      id: m.id || m.unique_id || m.matchId || String(Math.random()),
      series: friendlySeries(m),
      teams: Array.isArray(m.teams) ? m.teams : [m.teamInfo?.[0]?.name, m.teamInfo?.[1]?.name].filter(Boolean),
      matchType: m.matchType || m.format || '',
      status: m.status || m.venue || '',
      score: (() => {
        const s1 = m.score?.[0];
        const s2 = m.score?.[1];
        const a = s1 ? `${s1.inning || ''} ${s1.r}-${s1.w} (${s1.o})` : '';
        const b = s2 ? `${s2.inning || ''} ${s2.r}-${s2.w} (${s2.o})` : '';
        return [a, b].filter(Boolean).join(' | ');
      })(),
      startsAt: m.dateTimeGMT || m.date || null,
    }));

    cache = { at: now, data: items };
    return res.json({ items, cached: false });
  } catch (e) {
    console.error('Live scores error', e.message);
    return res.status(200).json({ items: [], error: 'Unable to fetch live scores right now.' });
  }
});

module.exports = router;


