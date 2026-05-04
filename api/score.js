// api/score.js — with Upstash Redis persistent storage
const https = require('https');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin123';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const REDIS_URL = process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || '';

// ── REDIS HELPERS ─────────────────────────────────────────────────────────────
function redisRequest(method, path, bodyData) {
  return new Promise((resolve, reject) => {
    if (!REDIS_URL) { resolve({}); return; }
    const url = new URL(REDIS_URL);
    const postBody = bodyData !== null ? JSON.stringify(bodyData) : null;
    const options = {
      hostname: url.hostname,
      path: path,
      method: method,
      headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }
    };
    if (postBody) options.headers['Content-Length'] = Buffer.byteLength(postBody);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); } });
    });
    req.on('error', reject);
    if (postBody) req.write(postBody);
    req.end();
  });
}

async function getSubmissions() {
  try {
    if (!REDIS_URL) return [];
    const res = await redisRequest('GET', '/get/nw_submissions', null);
    if (!res || res.result === null || res.result === undefined) return [];
    let parsed = res.result;
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
    if (!REDIS_URL) return { error: 'No Redis URL' };
    // Upstash REST: SET key value via pipeline
    const value = JSON.stringify(submissions);
    const res = await redisRequest('POST', `/set/nw_submissions/${encodeURIComponent(value)}`, null);
    return res;
  } catch(e) {
    console.error('saveSubmissions error:', e.message);
    return { error: e.message };
  }
}

async function clearSubmissions() {
  try {
    if (!REDIS_URL) return;
    await redisRequest('POST', '/del/nw_submissions', null);
  } catch(e) {}
}

// ── ANTHROPIC ─────────────────────────────────────────────────────────────────
function callAnthropic(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
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
    req.write(body);
    req.end();
  });
}

// ── QUESTIONS ─────────────────────────────────────────────────────────────────
const QUESTIONS = [
  { id:1, topic:'Multi-Document Hallucination Control',
    ctx:'Document A: "NextWealth was founded in 2014 and operates 11 delivery centers across India." Document B: "NextWealth Q3 2024 revenue grew 34% YoY, driven by Gen AI and Trust & Safety services." Document C: "NextWealth employs over 7,000 people." Question: "When was NextWealth founded, how many employees does it have, and what was its Q3 2024 profit margin?"',
    expected:'Founded: 2014 (Doc A). Employees: 7,000+ (Doc C). Profit margin: Insufficient information — revenue growth mentioned but not profit margin.' },
  { id:2, topic:'Complex Customer Escalation',
    ctx:'Customer: "I\'ve been waiting 3 weeks for my refund. Called twice, told 5-7 business days each time. Now charged AGAIN for same item. Want resolved TODAY or disputing with bank." Policy: Refunds 5-7 days. Duplicate charges escalate to billing in 2 hours. Chargeback threats = Priority 1. Priority 1 = manager callback in 1 hour.',
    expected:'Addresses all 3 issues: late refund + duplicate charge escalation + chargeback de-escalation. Flags PRIORITY 1. Manager callback mentioned. Under 120 words. No defensive language.' },
  { id:3, topic:'Subtle Implicit Bias Detection',
    ctx:'Sarah: "consistently delivers quality work, well-liked, great at keeping everyone comfortable." James: "strong technical leadership, not afraid to make tough calls." Ravi: "works hard, significantly improved communication this quarter."',
    expected:'Sarah: social warmth bias (gender). Ravi: improved communication implies prior deficit (cultural bias). Different standards set for each. Neutral rewrites focused on deliverables.' },
  { id:4, topic:'Ambiguous Classification with Confidence',
    ctx:'Tickets: 1."Nothing works after update" 2."Charged twice" 3."AI gave wrong medical advice" 4."Forgot password, email gone" 5."Export broken on Firefox" 6."Send my data" 7."Response times doubled" 8."Colleague sees my files". Categories: Bug|Billing|Safety & Liability|Account Access|Performance|Data Privacy Request|Security Incident',
    expected:'Ticket 3: Safety & Liability ESCALATE. Ticket 8: Security Incident ESCALATE. Ticket 1: Needs Review. Others classified with confidence scores.' },
  { id:5, topic:'Nested Entity Extraction with Calculation',
    ctx:'"Priya Sharma, Senior Manager, NextWealth Bengaluru, expenses 14 April 2026: Rs4,200 travel (3x Rs1,400), Rs850 meals, Rs12,000 entertainment approved by Arjun Mehta. Entertainment limit Rs10,000 without CFO approval. Total: Rs17,050."',
    expected:'JSON extracted. Arithmetic verified (4200+850+12000=17050). Policy violation: entertainment exceeds limit by Rs2,000. CFO approval required.' },
  { id:6, topic:'Dual Audience Explanation',
    ctx:'Concept: RAG (Retrieval Augmented Generation). Audience 1: 10-year-old. Audience 2: Business executive. Different analogy each, no jargon, under 80 words each, audience-specific closing.',
    expected:'Two labelled explanations. Different analogies. Under 80 words. No jargon. Relevant closing for each audience.' },
  { id:7, topic:'Four Perspectives + Conflict Summary',
    ctx:'Company replaces human content moderation with AI. Perspectives: moderation worker, CEO, child safety NGO, AI ethics researcher. 60 words each + 50-word disagreement summary.',
    expected:'Four 60-word first-person perspectives. 50-word disagreement summary. Core tension: efficiency vs safety vs ethics. No AI opinion.' },
  { id:8, topic:'Multi-Condition Policy Reasoning',
    ctx:'Refund policy: 30-day standard. Digital non-refundable unless defective. Defective: 60-day refund, replacement first. Gold/Platinum: 45 days. Sale items: final unless defective. Case 1: Gold, digital course 40 days, won\'t load. Case 2: Regular, sale item 35 days, no defect. Case 3: Platinum, headphones 44 days, earbud broken.',
    expected:'Case 1: Approved (Gold 45-day + digital defect). Case 2: Rejected (sale no defect). Case 3: Approved (Platinum 45-day + defective, replacement first).' }
];

async function scoreAllPrompts(prompts) {
  const results = [];
  for (let i = 0; i < 8; i++) {
    const q = QUESTIONS[i];
    const prompt = (prompts[i] || '').trim();
    if (!prompt) {
      results.push({ weighted_score:0, goal_achievement:0, clarity:0, creativity:0, hallucination_control:0, feedback:'No answer submitted.', simulated_response:'' });
      continue;
    }
    try {
      const sp = `You are an expert prompt engineering evaluator for NextWealth's contest.
Scenario: ${q.ctx}
Expected response: ${q.expected}
Participant prompt: """${prompt}"""
Score on 4 criteria (1-5 each):
1. GOAL_ACHIEVEMENT (40%): Output matches expected?
2. CLARITY (25%): Well-structured with clear format?
3. CREATIVITY (20%): Clever or distinctive?
4. HALLUCINATION_CONTROL (15%): Prevents unsupported claims?
Respond in exact JSON only:
{"simulated_response":"...","goal_achievement":N,"clarity":N,"creativity":N,"hallucination_control":N,"feedback":"2 sentence feedback"}`;
      const data = await callAnthropic(sp);
      const text = data.content[0].text.replace(/```json|```/g,'').trim();
      const r = JSON.parse(text);
      r.weighted_score = Math.round((r.goal_achievement*0.4+r.clarity*0.25+r.creativity*0.2+r.hallucination_control*0.15)*10);
      results.push(r);
    } catch(e) {
      results.push({ weighted_score:0, goal_achievement:0, clarity:0, creativity:0, hallucination_control:0, feedback:'Error: '+e.message, simulated_response:'' });
    }
  }
  return results;
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

    // Debug endpoint
    if (action === 'debug') {
      res.status(200).json({
        hasRedisUrl: !!REDIS_URL,
        hasRedisToken: !!REDIS_TOKEN,
        hasApiKey: !!ANTHROPIC_API_KEY,
        redisUrlPrefix: REDIS_URL ? REDIS_URL.substring(0,30)+'...' : 'NOT SET'
      });
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
    res.status(400).json({ error:'Unknown action' });
    return;
  }

  if (req.method === 'DELETE') {
    const { password } = req.query;
    if (password !== ADMIN_PASSWORD) { res.status(403).json({ error:'Unauthorized' }); return; }
    await clearSubmissions();
    res.status(200).json({ success:true });
    return;
  }

  if (req.method === 'POST') {
    const body = await parseBody(req);
    const { participant, prompts } = body;
    if (!participant || !prompts) {
      res.status(400).json({ error:'Missing fields', received:Object.keys(body) });
      return;
    }
    if (!ANTHROPIC_API_KEY) {
      res.status(500).json({ error:'ANTHROPIC_API_KEY not configured' });
      return;
    }
    try {
      const results = await scoreAllPrompts(prompts);
      const total = Math.round(results.reduce((s,r) => s+(r.weighted_score||0),0)*10)/10;
      const entry = { participant, prompts, results, total, timestamp:Date.now() };
      const submissions = await getSubmissions();
      const idx = submissions.findIndex(s => s.participant.email === participant.email);
      if (idx >= 0) submissions[idx] = entry;
      else submissions.push(entry);
      const saveResult = await saveSubmissions(submissions);
      const sorted = [...submissions].sort((a,b) => b.total - a.total);
      const rank = sorted.findIndex(s => s.participant.email === participant.email) + 1;
      res.status(200).json({ success:true, results, total, rank, totalParticipants:submissions.length, saveResult });
    } catch(e) {
      res.status(500).json({ error:e.message });
    }
    return;
  }

  res.status(405).json({ error:'Method not allowed' });
};
