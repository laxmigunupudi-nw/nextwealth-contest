// api/score.js
const https = require('https');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin123';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

let submissions = [];

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

const QUESTIONS = [
  {
    id: 1, topic: 'Multi-Document Hallucination Control',
    ctx: 'Document A: "NextWealth was founded in 2014 and operates 11 delivery centers across India." Document B: "NextWealth Q3 2024 revenue grew 34% YoY, driven by Gen AI and Trust & Safety services." Document C: "NextWealth employs over 7,000 people." Question asked: "When was NextWealth founded, how many employees does it have, and what was its Q3 2024 profit margin?"',
    expected: 'Founded: 2014 (Document A). Employees: 7,000+ (Document C). Profit margin: Insufficient information — documents mention revenue growth but not profit margin.'
  },
  {
    id: 2, topic: 'Complex Customer Escalation',
    ctx: 'Customer: "I\'ve been waiting 3 weeks for my refund. I called twice and was told 5-7 business days each time. I\'ve now been charged AGAIN for the same item. I want this resolved TODAY or I\'m disputing with my bank." Policy: Refunds in 5-7 days. Duplicate charges escalate to billing within 2 hours. Chargeback threats = Priority 1. Priority 1 = manager callback within 1 hour.',
    expected: 'Addresses all 3 issues separately: late refund + duplicate charge escalation + chargeback de-escalation. Flags PRIORITY 1. Manager callback mentioned. Under 120 words. No defensive language.'
  },
  {
    id: 3, topic: 'Subtle Implicit Bias Detection',
    ctx: 'Review 1 - Sarah: "Sarah consistently delivers quality work and is well-liked by the team. She\'s great at keeping everyone comfortable during meetings." Review 2 - James: "James demonstrates strong technical leadership and isn\'t afraid to make tough calls under pressure." Review 3 - Ravi: "Ravi works hard and has significantly improved his communication this quarter."',
    expected: 'Sarah: praised for social warmth not technical output (gender bias). James: assertiveness praised (different standard). Ravi: "improved communication" implies prior deficit (cultural bias). Neutral rewrites for all three focused on deliverables and outcomes.'
  },
  {
    id: 4, topic: 'Ambiguous Classification with Confidence & Escalation',
    ctx: 'Tickets: 1."Nothing works after your update" 2."I was charged twice this month" 3."Your AI gave me completely wrong medical advice" 4."I can\'t remember my password and my email no longer exists" 5."The export button does nothing on Firefox" 6."Please send me all data you hold about me" 7."Response times have doubled since last week" 8."My colleague can see my private files". Categories: Bug|Billing|Safety & Liability|Account Access|Performance|Data Privacy Request|Security Incident',
    expected: 'Ticket 3: Safety & Liability — ESCALATE (AI medical advice liability). Ticket 8: Security Incident — ESCALATE (unauthorized access). Ticket 1: Needs Review (ambiguous Bug/Performance). All others classified with confidence scores.'
  },
  {
    id: 5, topic: 'Nested Entity Extraction with Policy Calculation',
    ctx: '"Priya Sharma, Senior Manager at NextWealth Bengaluru, submitted expenses on 14 April 2026: Rs4,200 travel (3 trips at Rs1,400 each), Rs850 meals, Rs12,000 client entertainment pre-approved by director Arjun Mehta. Policy: client entertainment limit Rs10,000 without CFO approval. Total claimed: Rs17,050."',
    expected: 'JSON with all entities extracted. Arithmetic verified: 4200+850+12000=17050 correct. Policy violation: entertainment Rs12,000 exceeds Rs10,000 limit by Rs2,000. CFO approval required flagged.'
  },
  {
    id: 6, topic: 'Dual Audience Explanation',
    ctx: 'Concept: Retrieval Augmented Generation (RAG). Audience 1: A 10-year-old child. Audience 2: A senior business executive with no technical background. Constraints: Different analogy for each. No technical jargon in either. Under 80 words each. Audience-specific closing sentence.',
    expected: 'Two labelled explanations. Different analogies. Both under 80 words. Zero jargon. Child closing relates to daily life. Executive closing mentions business value.'
  },
  {
    id: 7, topic: 'Four Perspectives + Conflict Summary',
    ctx: 'Scenario: A large company replaces its entire human content moderation team with AI. Four perspectives (60 words each): content moderation worker being replaced, company CEO, child safety NGO, AI ethics researcher. Plus a 50-word summary of the key disagreement.',
    expected: 'Four labelled 60-word perspectives in first person. Worker: job loss. CEO: efficiency. NGO: safety accuracy concerns. Researcher: ethical accountability. 50-word disagreement summary identifies core tension. No AI opinion anywhere.'
  },
  {
    id: 8, topic: 'Multi-Condition Policy Reasoning',
    ctx: 'Policy: Standard refund 30 days. Digital products non-refundable unless defective. Defective items: full refund within 60 days, replacement first. Gold/Platinum members: 45-day window. Sale items: final sale unless defective. Cases: 1) Gold member, digital course 40 days ago, claims it won\'t load. 2) Regular customer, physical sale item 35 days ago, no defect. 3) Platinum member, headphones 44 days ago, one earbud broken.',
    expected: 'Case 1: Approved — Gold 45-day window + digital defect exception. Case 2: Rejected — sale item, no defect, final sale policy. Case 3: Approved — Platinum 45-day window met, defective item, offer replacement first.'
  }
];

async function scoreAllPrompts(prompts) {
  const results = [];
  for (let i = 0; i < 8; i++) {
    const q = QUESTIONS[i];
    const prompt = (prompts[i] || '').trim();
    if (!prompt) {
      results.push({ weighted_score: 0, goal_achievement: 0, clarity: 0, creativity: 0, hallucination_control: 0, feedback: 'No answer submitted.', simulated_response: '' });
      continue;
    }
    try {
      const sp = `You are an expert prompt engineering evaluator for NextWealth's Advanced Prompt Engineering Contest.

Scenario context: ${q.ctx}

Expected ideal response: ${q.expected}

Participant's prompt: """${prompt}"""

Simulate running this participant's prompt against the scenario context. Then score on 4 criteria (1-5 each):
1. GOAL_ACHIEVEMENT (40%): Does the simulated output match the expected response?
2. CLARITY (25%): Is the prompt well-structured with clear output format and constraints?
3. CREATIVITY (20%): Does it show a clever, original, or distinctive prompting technique?
4. HALLUCINATION_CONTROL (15%): Does it prevent unsupported claims and handle ambiguity?

Respond in this exact JSON only, no other text:
{"simulated_response":"...","goal_achievement":N,"clarity":N,"creativity":N,"hallucination_control":N,"feedback":"2 concise sentences of constructive feedback"}`;

      const data = await callAnthropic(sp);
      const text = data.content[0].text.replace(/```json|```/g, '').trim();
      const r = JSON.parse(text);
      r.weighted_score = Math.round((r.goal_achievement * 0.4 + r.clarity * 0.25 + r.creativity * 0.2 + r.hallucination_control * 0.15) * 10);
      results.push(r);
    } catch (e) {
      results.push({ weighted_score: 0, goal_achievement: 0, clarity: 0, creativity: 0, hallucination_control: 0, feedback: 'Evaluation error: ' + e.message, simulated_response: '' });
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
      try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
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
      const sorted = [...submissions].sort((a, b) => b.total - a.total);
      sorted.forEach((s, i) => s.rank = i + 1);
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
      res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel environment variables.' });
      return;
    }
    try {
      const results = await scoreAllPrompts(prompts);
      const total = Math.round(results.reduce((s, r) => s + (r.weighted_score || 0), 0) * 10) / 10;
      const entry = { participant, prompts, results, total, timestamp: Date.now() };
      const idx = submissions.findIndex(s => s.participant.email === participant.email);
      if (idx >= 0) submissions[idx] = entry;
      else submissions.push(entry);
      const sorted = [...submissions].sort((a, b) => b.total - a.total);
      const rank = sorted.findIndex(s => s.participant.email === participant.email) + 1;
      res.status(200).json({ success: true, results, total, rank, totalParticipants: submissions.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
