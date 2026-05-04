// api/score.js — with Upstash Redis persistent storage
const https = require('https');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin123';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const REDIS_URL = process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_READ_ONLY_TOKEN || '';

// ── REDIS HELPERS (using https, no fetch) ─────────────────────────────────────
function redisRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(REDIS_URL);
    const postBody = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: path,
      method: method,
      headers: {
        'Authorization': `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
      }
    };
    if (postBody) options.headers['Content-Length'] = Buffer.byteLength(postBody);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({}); }
      });
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
    if (res.result) return JSON.parse(res.result);
    return [];
  } catch(e) { return []; }
}

async function saveSubmissions(submissions) {
  try {
    if (!REDIS_URL) return;
    const value = JSON.stringify(submissions);
    await redisRequest('POST', '/set/nw_submissions', [value]);
  } catch(e) { console.error('Redis save error:', e.message); }
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
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON from Anthropic')); }
      });
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
    ctx:'Customer: "I\'ve been waiting 3 weeks for my refund. I called twice, told 5-7 business days each time. I\'ve now been charged AGAIN for the same item. I want this resolved TODAY or I\'m disputing with my bank." Policy: Refunds in 5-7 days. Duplicate charges escalate to billing within 2 hours. Chargeback threats = Priority 1. Priority 1 = manager callback within 1 hour.',
    expected:'Addresses all 3 issues: late refund + duplicate charge escalation + chargeback de-escalation. Flags PRIORITY 1. Manager callback mentioned. Under 120 words. No defensive language.' },
  { id:3, topic:'Subtle Implicit Bias Detection',
    ctx:'Sarah review: "Sarah consistently delivers quality work and is well-liked by the team. She\'s great at keeping everyone comfortable during meetings." James review: "James demonstrates strong technical leadership and isn\'t afraid to make tough calls under pressure." Ravi review: "Ravi works hard and has significantly improved his communication this quarter."',
    expected:'Sarah: praised for social warmth not technical output (gender bias). James: assertiveness praised differently. Ravi: "improved communication" implies prior deficit (cultural bias). Neutral rewrites for all three.' },
  { id:4, topic:'Ambiguous Classification with Confidence & Escalation',
    ctx:'Tickets: 1."Nothing works after your update" 2."I was charged twice" 3."Your AI gave wrong medical advice" 4."Can\'t remember password, email no longer exists" 5."Export button does nothing on Firefox" 6."Send me all data you hold about me" 7."Response times doubled since last week" 8."My colleague can see my private files". Categories: Bug|Billing|Safety & Liability|Account Access|Performance|Data Privacy Request|Security Incident',
    expected:'Ticket 3: Safety & Liability — ESCALATE. Ticket 8: Security Incident — ESCALATE. Ticket 1: Needs Review (ambiguous). All others classified with confidence scores.' },
  { id:5, topic:'Nested Entity Extraction with Policy Calculation',
    ctx:'"Priya Sharma, Senior Manager at NextWealth Bengaluru, submitted expenses on 14 April 2026: Rs4,200 travel (3 trips at Rs1,400 each), Rs850 meals, Rs12,000 client entertainment pre-approved by director Arjun Mehta. Policy: client entertainment limit Rs10,000 without CFO approval. Total claimed: Rs17,050."',
    expected:'JSON extracted correctly. Arithmetic verified: 4200+850+12000=17050. Policy violation: entertainment Rs12,000 exceeds Rs10,000 by Rs2,000. CFO approval flagged.' },
  { id:6, topic:'Dual Audience Explanation',
    ctx:'Concept: Retrieval Augmented Generation (RAG). Audience 1: 10-year-old child. Audience 2: Senior business executive. Constraints: Different analogy each, no jargon, under 80 words each, audience-specific closing sentence.',
    expected:'Two labelled explanations. Different analogies. Both under 80 words. Zero jargon. Child closing = daily life relevance. Executive closing = business value.' },
  { id:7, topic:'Four Perspectives + Conflict Summary',
    ctx:'Scenario: Company replaces human content moderation team with AI. Perspectives (60 words each): moderation worker, CEO, child safety NGO, AI ethics researcher. Plus 50-word disagreement summary.',
    expected:'Four labelled 60-word first-person perspectives. 50-word disagreement summary. Core tension identified: efficiency vs safety vs ethics. No AI opinion.' },
  { id:8, topic:'Multi-Condition Policy Reasoning',
    ctx:'Policy: Standard 30-day refund. Digital = non-refundable unless defective. Defective = full refund within 60 days, replacement first. Gold/Platinum = 45 days. Sale items = final unless defective. Case 1: Gold member, digital course 40 days ago, won\'t load. Case 2: Regular, physical sale item 35 days, no defect. Case 3: Platinum, headphones 44 days, earbud broken.',
    expected:'Case 1: Approved (Gold 45-day + digital defect). Case 2: Rejected (sale, no defect). Case 3: Approved (Platinum 45-day + defective, offer replacement first).' }
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
3. CREATIVITY (20%): Clever or distinctive approach?
4. HALLUCINATION_CONTROL (15%): Prevents unsupported claims?
Respond in exact JSON only:
{"simulated_response":"...","goal_achievement":N,"clarity":N,"creativity":N,"hallucination_control":N,"feedback":"2 sentence feedback"}`;
      const data = await callAnthropic(sp);
      const text = data.content[0].text.replace(/```json|```/g,'').trim();
      const r = JSON.parse(text);
      r.weighted_score = Math.round((r.goal_achievement*0.4 + r.clarity*0.25 + r.creativity*0.2 + r.hallucination_control*0.15)*10);
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
      res.status(400).json({ error:'Missing required fields', received:Object.keys(body) });
      return;
    }
    if (!ANTHROPIC_API_KEY) {
      res.status(500).json({ error:'ANTHROPIC_API_KEY not configured' });
      return;
    }
    try {
      const results = await scoreAllPrompts(prompts);
      const total = Math.round(results.reduce((s,r) => s+(r.weighted_score||0), 0)*10)/10;
      const entry = { participant, prompts, results, total, timestamp:Date.now() };
      const submissions = await getSubmissions();
      const idx = submissions.findIndex(s => s.participant.email === participant.email);
      if (idx >= 0) submissions[idx] = entry;
      else submissions.push(entry);
      await saveSubmissions(submissions);
      const sorted = [...submissions].sort((a,b) => b.total - a.total);
      const rank = sorted.findIndex(s => s.participant.email === participant.email) + 1;
      res.status(200).json({ success:true, results, total, rank, totalParticipants:submissions.length });
    } catch(e) {
      res.status(500).json({ error:e.message });
    }
    return;
  }

  res.status(405).json({ error:'Method not allowed' });
};
