// api/score.js
const https = require('https');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin123';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

let submissions = [];

function callAnthropic(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
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

const QUESTIONS = [
  { id:1, topic:'Hallucination Control',
    ctx:'Context: "NextWealth provides AI data services: annotation, data collection, model evaluation, HITL support." Question: "Does NextWealth manufacture electric vehicles?"',
    expected:'Insufficient information. Context only states NextWealth provides AI data services. No mention of electric vehicle manufacturing.' },
  { id:2, topic:'Customer Support Chatbot',
    ctx:'Customer: "This is the third time my delivery is delayed. I needed the item today. This is unacceptable."',
    expected:'I\'m truly sorry your delivery has been delayed again. Let me check your order and arrange priority re-delivery, replacement, or full refund.' },
  { id:3, topic:'Bias Detection',
    ctx:'AI text: "Men are usually better suited for technical leadership roles because they are more logical, while women are better at communication roles."',
    expected:'Bias found. Gender stereotype about cognitive ability. Neutral rewrite: Leadership roles should be filled based on skills and performance — not gender.' },
  { id:4, topic:'Data Classification',
    ctx:'Tickets: 1."App crashes on PDF upload" 2."Change billing email" 3."Dashboard slow" 4."Delete account". Categories: Bug|Account Support|Performance Issue|Data Deletion Request',
    expected:'1|Bug 2|Account Support 3|Performance Issue 4|Data Deletion Request' },
  { id:5, topic:'Entity Extraction',
    ctx:'"Ravi Kumar from Bengaluru ordered 3 laptops on 12 March 2026. Total Rs1,80,000. Delivery by 18 March 2026."',
    expected:'{"customer_name":"Ravi Kumar","city":"Bengaluru","item":"laptops","quantity":3,"order_date":"12 March 2026","order_value":"Rs1,80,000","expected_delivery_date":"18 March 2026"}' },
  { id:6, topic:'Explain LLMs Simply',
    ctx:'Explain LLMs to a 12-year-old using only a cooking or sports analogy. No jargon. Under 100 words.',
    expected:'Imagine a chef who has read every recipe book. LLMs work the same — trained on billions of sentences, predicting the next word. That\'s why AI chatbots can hold real conversations.' },
  { id:7, topic:'Role-Based Perspectives',
    ctx:'Three perspectives on AI\'s impact on employment: optimist economist, worried factory worker, neutral journalist. 60 words each. No AI opinion.',
    expected:'Economist: AI boosts productivity. Factory Worker: Machines do my job faster now. Journalist: Experts split on net job impact.' },
  { id:8, topic:'Chain-of-Thought Reasoning',
    ctx:'Customer ordered laptop, received tablet. Policy: refunds for wrong items within 30 days.',
    expected:'Step 1: Ordered laptop. Step 2: Got tablet. Step 3: Policy covers this. Step 4: Within 30 days. Decision: Approved.' }
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
Participant's prompt: """${prompt}"""
Simulate running this prompt. Score on 4 criteria (1-5):
1. GOAL_ACHIEVEMENT (40%): Does output match expected?
2. CLARITY (25%): Well-structured with clear output format?
3. CREATIVITY (20%): Clever or distinctive approach?
4. HALLUCINATION_CONTROL (15%): Prevents unsupported claims?
Respond in exact JSON only, no other text:
{"simulated_response":"...","goal_achievement":N,"clarity":N,"creativity":N,"hallucination_control":N,"feedback":"2 sentence feedback"}`;

      const data = await callAnthropic(sp);
      const text = data.content[0].text.replace(/```json|```/g, '').trim();
      const r = JSON.parse(text);
      r.weighted_score = Math.round((r.goal_achievement*0.4 + r.clarity*0.25 + r.creativity*0.2 + r.hallucination_control*0.15) * 10);
      results.push(r);
    } catch(e) {
      results.push({ weighted_score:0, goal_achievement:0, clarity:0, creativity:0, hallucination_control:0, feedback:'Evaluation error: '+e.message, simulated_response:'' });
    }
  }
  return results;
}

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') { resolve(req.body); return; }
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch(e) { resolve({}); }
    });
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (req.method === 'GET') {
    const { action, password } = req.query;
    if (action === 'all') {
      if (password !== ADMIN_PASSWORD) { res.status(403).json({ error: 'Unauthorized' }); return; }
      const sorted = [...submissions].sort((a,b) => b.total - a.total);
      sorted.forEach((s,i) => s.rank = i+1);
      res.status(200).json({ submissions: sorted });
      return;
    }
    res.status(400).json({ error: 'Unknown action' });
    return;
  }

  if (req.method === 'DELETE') {
    const { password } = req.query;
    if (password !== ADMIN_PASSWORD) { res.status(403).json({ error: 'Unauthorized' }); return; }
    submissions = [];
    res.status(200).json({ success: true });
    return;
  }

  if (req.method === 'POST') {
    const body = await parseBody(req);
    const { participant, prompts } = body;

    if (!participant || !prompts) {
      res.status(400).json({ error: 'Missing required fields: participant and prompts', received: Object.keys(body) });
      return;
    }
    if (!ANTHROPIC_API_KEY) {
      res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in environment variables.' });
      return;
    }

    try {
      const results = await scoreAllPrompts(prompts);
      const total = Math.round(results.reduce((s, r) => s + (r.weighted_score || 0), 0) * 10) / 10;
      const entry = { participant, prompts, results, total, timestamp: Date.now() };
      const idx = submissions.findIndex(s => s.participant.email === participant.email);
      if (idx >= 0) submissions[idx] = entry;
      else submissions.push(entry);
      const sorted = [...submissions].sort((a,b) => b.total - a.total);
      const rank = sorted.findIndex(s => s.participant.email === participant.email) + 1;
      res.status(200).json({ success: true, results, total, rank, totalParticipants: submissions.length });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
