// Netlify Function — resolves a username or phone number to its account email.
// Runs server-side with a direct Postgres connection, so it doesn't depend on
// the Data API's anonymous-role path (which proved unreliable for unauthenticated calls).
// Only ever returns an email string or null — never any other profile data.

const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{"error":"Method not allowed"}' };

  if (!process.env.DATABASE_URL) {
    return { statusCode: 500, headers, body: JSON.stringify({
      error: 'DATABASE_URL is not set on this site. Add it in Netlify → Site settings → Environment variables.'
    })};
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: '{"error":"Invalid JSON"}' }; }

  const identifier = (payload.identifier || '').trim();
  if (!identifier) return { statusCode: 400, headers, body: '{"error":"Missing identifier"}' };

  try {
    const rows = await sql`
      SELECT lower(email) AS email FROM profiles
      WHERE lower(username) = lower(${identifier}) OR phone = ${identifier}
      LIMIT 1
    `;
    const email = rows.length ? rows[0].email : null;
    return { statusCode: 200, headers, body: JSON.stringify({ email }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'lookup_failed', detail: err.message }) };
  }
};
