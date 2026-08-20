// Netlify Function — AI Project Assistant
// The browser sends a question plus a context snapshot that was already
// fetched under the user's own JWT, so RLS has scoped it to that user.
// The API key never leaves the server.

const MODEL = 'claude-sonnet-4-6';

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{"error":"Method not allowed"}' };

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { statusCode: 500, headers, body: JSON.stringify({
      answer: 'ANTHROPIC_API_KEY is not set on this site. Add it in Netlify → Site settings → Environment variables.'
    })};
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: '{"error":"Invalid JSON"}' }; }

  const { question, context, lang = 'ar', history = [] } = payload;
  if (!question) return { statusCode: 400, headers, body: '{"error":"Missing question"}' };

  // Cap the payload so a large workspace can't blow the context window.
  const trimmed = {
    today: context?.today,
    summary: context?.summary,
    projects: (context?.projects || []).slice(0, 40),
    open_tasks: (context?.open_tasks || []).slice(0, 120),
    pending_milestones: (context?.pending_milestones || []).slice(0, 40)
  };

  const system = `You are the project assistant inside Kayan, a project management platform.

You answer ONLY from the JSON workspace data supplied in the user message. That data belongs to the
signed-in project manager and is already scoped to them by database row-level security.

Rules:
- Never invent projects, tasks, dates, names or numbers. If the data does not contain the answer, say so plainly.
- Be concise and decision-oriented. Lead with the answer, then the evidence from the data.
- When asked why something is at risk or delayed, cite the concrete drivers: overdue task counts,
  the gap between planned and actual progress (variance), approaching milestones, blocked tasks.
- Reference specific project and task names from the data.
- Health values: on_track / at_risk / delayed. Variance = actual_progress - planned_progress.
- When asked for a status report, structure it: overall position, progress vs plan, key risks,
  overdue items, upcoming milestones, and what needs escalation.
- Respond in ${lang === 'ar' ? 'Arabic (Saudi professional register, addressing the reader in the masculine form)' : 'English'}.
- Plain text only. No markdown headers or code fences.`;

  const messages = [
    ...history.filter(m => m && m.role && m.content)
              .slice(-6)
              .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) })),
    { role: 'user', content: `WORKSPACE DATA (JSON):\n${JSON.stringify(trimmed)}\n\nQUESTION:\n${question}` }
  ];

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1400, system, messages })
    });

    const data = await r.json();
    if (!r.ok) {
      return { statusCode: r.status, headers, body: JSON.stringify({
        answer: `Assistant error: ${data?.error?.message || r.status}`
      })};
    }

    const answer = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    return { statusCode: 200, headers, body: JSON.stringify({ answer: answer || '—' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ answer: `Assistant unavailable: ${err.message}` }) };
  }
};
