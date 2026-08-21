// Netlify Function — resolves a username or phone number to its account email.
// Uses Neon's HTTP SQL endpoint directly via fetch, so it needs NO npm dependencies
// (avoids any "module not found" bundling issue). Runs server-side with DATABASE_URL.
// Only ever returns an email string or null — never any other profile data.

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{"error":"Method not allowed"}' };

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DATABASE_URL not set' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: '{"error":"Invalid JSON"}' }; }

  const identifier = (payload.identifier || '').trim();
  if (!identifier) return { statusCode: 400, headers, body: '{"error":"Missing identifier"}' };

  // Build Neon's HTTP SQL endpoint from the Postgres connection string.
  let host, sqlUrl;
  try {
    const u = new URL(dbUrl);
    host = u.hostname.replace('-pooler', '');
    sqlUrl = `https://${host}/sql`;
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'bad DATABASE_URL', detail: e.message }) };
  }

  try {
    const r = await fetch(sqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Neon-Connection-String': dbUrl,
        'Neon-Raw-Text-Output': 'true',
        'Neon-Array-Mode': 'false'
      },
      body: JSON.stringify({
        query: 'SELECT lower(email) AS email FROM profiles WHERE lower(username) = lower($1) OR phone = $1 LIMIT 1',
        params: [identifier]
      })
    });

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'db_http_error', status: r.status, detail: t.slice(0, 300) }) };
    }

    const data = await r.json();
    const rows = data.rows || [];
    const email = rows.length ? rows[0].email : null;
    return { statusCode: 200, headers, body: JSON.stringify({ email }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'lookup_failed', detail: err.message }) };
  }
};
