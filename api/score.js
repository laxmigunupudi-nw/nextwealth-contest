// api/score.js
// Handles: scoring a prompt, saving results, fetching all results

const https = require('https');

// In-memory store (persists per Vercel instance)
// For production use Vercel KV — see README
let submissions = [];

function callAnthropic(apiKey, prompt) {
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
        'x-api-key': apiKey,
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
    expected:'I\'m truly sorry your delivery has been delayed again. I understand your frustration. Let me check your order and arrange priority re-delivery, replacement, or full refund. You\'ll hear back within the hour.' },
  { id:3, topic:'Bias Detection',
    ctx:'AI text: "Men are usually better suited for technical leadership roles because they are more logical, while women are better at communication roles."',
    expected:'Bias found. Gender stereotype about cognitive ability, unsupported by evidence. Neutral rewrite: Leadership roles should be filled based on skills, experience, and performance — not gender.' },
  { id:4, topic:'Data Classification',
    ctx:'Tickets: 1."App crashes on PDF upload" 2."Change billing email" 3."Dashboard slow" 4."Delete account". Categories: Bug|Account Support|Performance Issue|Data Deletion Request',
    expected:'1|Bug 2|Account Support 3|Performance Issue 4|Data Deletion Request' },
  { id:5, topic:'Entity Extraction',
    ctx:'"Ravi Kumar from Bengaluru ordered 3 laptops on 12 March 2026. Total ₹1,80,000. Delivery by 18 March 2026."',
    expected:'{"customer_name":"Ravi Kumar","city":"Bengaluru","item":"laptops","quantity":3,"order_date":"12 March 2026","order_value":"₹1,80,000","expected_delivery_date":"18 March 2026"}' },
  { id:6, topic:'Explain LLMs Simply',
    ctx:'Explain LLMs to a 12-year-old using only a cooking or sports analogy. No jargon. Under 100 words.',
    expected:'Imagine a chef who has read every recipe book. They blend patterns from millions of meals. LLMs work the same — trained on billions of sentences, predicting the next word. That\'s why AI chatbots can hold real conversations.' },
  { id:7, topic:'Role-Based Perspectives',
    ctx:'Three perspectives on AI\'s impact on employment: optimist economist, worried factory worker, neutral journalist. 60 words each. No AI opinion.',
    expected:'Economist: AI boosts productivity, creates industries. Factory Worker: My skills took years; machines do it faster now. Journalist: Experts split — losses in routine roles, growth in tech roles.' },
  { id:8, topic:'Chain-of-Thought Reasoning',
    ctx:'Customer ordered laptop, received tablet. Policy: refunds for wrong items within 30 days.',
    expected:'Step 1: Ordered laptop. Step 2: Got tablet — wrong item. Step 3: Policy covers this. Step 4: Within 30 days. Decision: Approved.' }
];

async function scoreAllPrompts(prompts, apiKey) {
  const results = [];
  for (let i = 0; i < 8; i++) {
    const q = QUESTIONS[i];
    const prompt = prompts[i];
    if (!prompt || !prompt.trim()) {
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
Respond in exact JSON only:
{"simulated_response":"...","goal_achievement":N,"clarity":N,"creativity":N,"hallucination_control":N,"feedback":"2 sentence feedback"}`;

      const data = await callAnthropic(apiKey, sp);
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // GET /api/score?action=all — fetch all submissions (admin)
  if (req.method === 'GET') {
    const { action, password } = req.query;
    if (action === 'all') {
      if (password !== (process.env.ADMIN_PASSWORD || 'Admin123')) {
        res.status(403).json({ error: 'Unauthorized' }); return;
      }
      res.status(200).json({ submissions: submissions.sort((a,b) => b.total - a.total) });
      return;
    }
    res.status(400).json({ error: 'Unknown action' });
    return;
  }

  // POST /api/score — score and save a submission
  if (req.method === 'POST') {
    const { participant, prompts, apiKey } = req.body;
    if (!participant || !prompts || !apiKey) {
      res.status(400).json({ error: 'Missing required fields' }); return;
    }

    try {
      const results = await scoreAllPrompts(prompts, apiKey);
      const total = Math.round(results.reduce((s, r) => s + (r.weighted_score || 0), 0) * 10) / 10;
      const entry = { participant, prompts, results, total, timestamp: Date.now() };

      // Replace if participant already submitted
      const idx = submissions.findIndex(s => s.participant.email === participant.email);
      if (idx >= 0) submissions[idx] = entry;
      else submissions.push(entry);

      res.status(200).json({ success: true, results, total });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
