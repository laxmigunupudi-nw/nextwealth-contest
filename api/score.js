// api/score.js - Clean, reliable version
const https = require('https');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin123';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const REDIS_URL = process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || '';

// ── REDIS via pipeline ────────────────────────────────────────────────────────
function redisPipeline(commands) {
  return new Promise((resolve, reject) => {
    if (!REDIS_URL) { resolve([]); return; }
    const url = new URL(REDIS_URL);
    const body = JSON.stringify(commands);
    const options = {
      hostname: url.hostname, path: '/pipeline', method: 'POST',
      headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve([]); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function getSubmissions() {
  try {
    if (!REDIS_URL) return [];
    const res = await redisPipeline([["GET", "nw_submissions"]]);
    if (!res || !res[0] || !res[0].result) return [];
    let parsed = res[0].result;
    while (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch(e) { break; } }
    return Array.isArray(parsed) ? parsed : [];
  } catch(e) { console.error('getSubmissions:', e.message); return []; }
}

async function saveSubmissions(submissions) {
  try {
    if (!REDIS_URL) return;
    await redisPipeline([["SET", "nw_submissions", JSON.stringify(submissions)]]);
  } catch(e) { console.error('saveSubmissions:', e.message); }
}

// ── ANTHROPIC ─────────────────────────────────────────────────────────────────
function callAnthropic(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 800, messages: [{ role: 'user', content: prompt }] });
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function scoreOne(prompt, aiResponse, context, expected, topic) {
  if (!prompt && !aiResponse) {
    return { weighted_score:0, goal_achievement:0, clarity:0, creativity:0, hallucination_control:0, feedback:'No answer submitted.' };
  }
  const sp = `You are an expert prompt engineering evaluator for NextWealth's contest.
Topic: ${topic}
Context: ${context}
Expected response: ${expected}
Participant prompt: """${prompt||'(none)'}"""
AI response produced: """${aiResponse||'(none)'}"""
Score the PROMPT on 4 criteria (1-5 each):
1. GOAL_ACHIEVEMENT (40%): Does AI response match expected?
2. CLARITY (25%): Well-structured with clear format instructions?
3. CREATIVITY (20%): Clever or distinctive technique?
4. HALLUCINATION_CONTROL (15%): Constrains AI to prevent unsupported claims?
Respond in exact JSON only:
{"goal_achievement":N,"clarity":N,"creativity":N,"hallucination_control":N,"feedback":"2 sentence feedback"}`;

  const data = await callAnthropic(sp);
  const text = data.content[0].text.replace(/```json|```/g, '').trim();
  const r = JSON.parse(text);
  r.weighted_score = Math.round((r.goal_achievement*0.4 + r.clarity*0.25 + r.creativity*0.2 + r.hallucination_control*0.15) * 10);
  return r;
}

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') { resolve(req.body); return; }
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
  });
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // ── GET ──
  if (req.method === 'GET') {
    const { action, password } = req.query;

    if (action === 'debug') {
      let redisTest = 'not tested';
      try {
        await redisPipeline([["SET", "nw_test", "ok"]]);
        const r = await redisPipeline([["GET", "nw_test"]]);
        redisTest = r[0]?.result === 'ok' ? 'READ/WRITE OK' : 'FAIL: ' + JSON.stringify(r);
        await redisPipeline([["DEL", "nw_test"]]);
      } catch(e) { redisTest = 'ERROR: ' + e.message; }
      res.status(200).json({ hasRedisUrl:!!REDIS_URL, hasRedisToken:!!REDIS_TOKEN, hasApiKey:!!ANTHROPIC_API_KEY, redisTest });
      return;
    }

    if (action === 'all') {
      if (password !== ADMIN_PASSWORD) { res.status(403).json({ error:'Unauthorized' }); return; }
      const submissions = await getSubmissions();
      const sorted = [...submissions].sort((a,b) => b.total - a.total);
      sorted.forEach((s,i) => s.rank = i+1);
      res.status(200).json({ submissions: sorted });
      return;
    }
    res.status(400).json({ error:'Unknown action' }); return;
  }

  // ── DELETE ──
  if (req.method === 'DELETE') {
    const { password } = req.query;
    if (password !== ADMIN_PASSWORD) { res.status(403).json({ error:'Unauthorized' }); return; }
    await redisPipeline([["DEL", "nw_submissions"]]);
    res.status(200).json({ success:true }); return;
  }

  // ── POST ──
  if (req.method === 'POST') {
    const body = await parseBody(req);
    if (!ANTHROPIC_API_KEY) { res.status(500).json({ error:'ANTHROPIC_API_KEY not set' }); return; }

    // Score single question (called after each question)
    if (body.action === 'score_single') {
      const { prompt, aiResponse, context, expected, topic } = body;
      try {
        const result = await scoreOne(prompt||'', aiResponse||'', context||'', expected||'', topic||'');
        res.status(200).json(result);
      } catch(e) { res.status(500).json({ error:e.message }); }
      return;
    }

    // Save final results (all scores already done, just save)
    if (body.action === 'save_results') {
      const { participant, prompts, aiResponses, results } = body;
      if (!participant) { res.status(400).json({ error:'Missing participant' }); return; }
      try {
        const total = Math.round((results||[]).reduce((s,r) => s+(r?.weighted_score||0), 0)*10)/10;
        const entry = { participant, prompts:prompts||[], aiResponses:aiResponses||[], results:results||[], total, timestamp:Date.now() };
        const submissions = await getSubmissions();
        const idx = submissions.findIndex(s => s.participant.email === participant.email);
        if (idx >= 0) submissions[idx] = entry; else submissions.push(entry);
        await saveSubmissions(submissions);
        res.status(200).json({ success:true, total });
      } catch(e) { res.status(500).json({ error:e.message }); }
      return;
    }

    res.status(400).json({ error:'Unknown action: ' + (body.action||'none') }); return;
  }

  res.status(405).json({ error:'Method not allowed' });
};
