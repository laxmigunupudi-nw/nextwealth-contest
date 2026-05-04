// api/score.js — Fixed Redis save
const https = require('https');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin123';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const REDIS_URL = process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || '';

// ── REDIS ─────────────────────────────────────────────────────────────────────
// Upstash REST API: POST /pipeline with array of commands
function redisPipeline(commands) {
  return new Promise((resolve, reject) => {
    if (!REDIS_URL) { resolve([]); return; }
    const url = new URL(REDIS_URL);
    const body = JSON.stringify(commands);
    const options = {
      hostname: url.hostname,
      path: '/pipeline',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getSubmissions() {
  try {
    if (!REDIS_URL) return [];
    const results = await redisPipeline([["GET", "nw_submissions"]]);
    if (!results || !results[0] || results[0].result === null) return [];
    let parsed = results[0].result;
    while (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch(e) { break; }
    }
    return Array.isArray(parsed) ? parsed : [];
  } catch(e) {
    console.error('getSubmissions error:', e.message);
    return [];
  }
}

async function saveSubmissions(submissions) {
  try {
    if (!REDIS_URL) return;
    const value = JSON.stringify(submissions);
    const results = await redisPipeline([["SET", "nw_submissions", value]]);
    console.log('Redis SET result:', JSON.stringify(results));
    return results;
  } catch(e) {
    console.error('saveSubmissions error:', e.message);
  }
}

// ── ANTHROPIC ─────────────────────────────────────────────────────────────────
function callAnthropic(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
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

// ── SCORE ONE ─────────────────────────────────────────────────────────────────
async function scoreOne(prompt, aiResponse, context, expected, topic) {
  if (!prompt && !aiResponse) {
    return { weighted_score:0, goal_achievement:0, clarity:0, creativity:0, hallucination_control:0, feedback:'No answer submitted.', simulated_response:'' };
  }
  const sp = `You are an expert prompt engineering evaluator for NextWealth's Prompt Engineering Contest.

Task topic: ${topic}
Scenario context: ${context}
Expected ideal response: ${expected}

Participant's prompt: """${prompt||'(none)'}"""
AI response their prompt produced: """${aiResponse||'(none)'}"""

Evaluate the participant's PROMPT on 4 criteria (1-5 each):
1. GOAL_ACHIEVEMENT (40%): How well does the AI response match the expected response?
2. CLARITY (25%): Is the prompt well-structured with clear instructions and output format?
3. CREATIVITY (20%): Does the prompt show a clever or distinctive technique?
4. HALLUCINATION_CONTROL (15%): Does the prompt constrain the AI to prevent unsupported claims?

Respond in exact JSON only:
{"goal_achievement":N,"clarity":N,"creativity":N,"hallucination_control":N,"feedback":"2 concise sentences"}`;

  const data = await callAnthropic(sp);
  const text = data.content[0].text.replace(/```json|```/g,'').trim();
  const r = JSON.parse(text);
  r.weighted_score = Math.round((r.goal_achievement*0.4+r.clarity*0.25+r.creativity*0.2+r.hallucination_control*0.15)*10);
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

  if (req.method === 'GET') {
    const { action, password } = req.query;

    if (action === 'debug') {
      // Test Redis read and write
      let redisTest = 'not tested';
      try {
        await saveSubmissions([{ test: true, time: Date.now() }]);
        const subs = await getSubmissions();
        redisTest = subs.length > 0 ? 'OK - read/write working' : 'FAIL - wrote but read empty';
        // Clean up test data
        await redisPipeline([["DEL", "nw_submissions"]]);
      } catch(e) {
        redisTest = 'ERROR: ' + e.message;
      }
      res.status(200).json({
        hasRedisUrl: !!REDIS_URL,
        hasRedisToken: !!REDIS_TOKEN,
        hasApiKey: !!ANTHROPIC_API_KEY,
        redisUrlPrefix: REDIS_URL ? REDIS_URL.substring(0,40)+'...' : 'NOT SET',
        redisTest
      });
      return;
    }

    if (action === 'all') {
      if (password !== ADMIN_PASSWORD) { res.status(403).json({ error:'Unauthorized' }); return; }
      const submissions = await getSubmissions();
      const sorted = [...submissions].sort((a,b) => b.total-a.total);
      sorted.forEach((s,i) => s.rank=i+1);
      res.status(200).json({ submissions: sorted });
      return;
    }
    res.status(400).json({ error:'Unknown action' });
    return;
  }

  if (req.method === 'DELETE') {
    const { password } = req.query;
    if (password !== ADMIN_PASSWORD) { res.status(403).json({ error:'Unauthorized' }); return; }
    await redisPipeline([["DEL", "nw_submissions"]]);
    res.status(200).json({ success:true });
    return;
  }

  if (req.method === 'POST') {
    const body = await parseBody(req);
    if (!ANTHROPIC_API_KEY) { res.status(500).json({ error:'ANTHROPIC_API_KEY not configured' }); return; }

    // Score single question (background + practice)
    if (body.action === 'score_single') {
      const { prompt, aiResponse, context, expected, topic } = body;
      try {
        const result = await scoreOne(prompt, aiResponse, context, expected, topic);
        res.status(200).json(result);
      } catch(e) {
        res.status(500).json({ error: e.message });
      }
      return;
    }

    // Save final results
    if (body.action === 'save_results') {
      const { participant, prompts, aiResponses, results } = body;
      if (!participant) { res.status(400).json({ error:'Missing participant' }); return; }
      try {
        const total = Math.round((results||[]).reduce((s,r) => s+(r?.weighted_score||0),0)*10)/10;
        const entry = { participant, prompts, aiResponses, results, total, timestamp:Date.now() };
        const submissions = await getSubmissions();
        const idx = submissions.findIndex(s => s.participant.email === participant.email);
        if (idx >= 0) submissions[idx] = entry;
        else submissions.push(entry);
        await saveSubmissions(submissions);
        const sorted = [...submissions].sort((a,b) => b.total-a.total);
        const rank = sorted.findIndex(s => s.participant.email === participant.email)+1;
        res.status(200).json({ success:true, total, rank, totalParticipants:submissions.length });
      } catch(e) {
        res.status(500).json({ error:e.message });
      }
      return;
    }

    res.status(400).json({ error:'Unknown action: ' + (body.action||'none') });
    return;
  }

  res.status(405).json({ error:'Method not allowed' });
};
