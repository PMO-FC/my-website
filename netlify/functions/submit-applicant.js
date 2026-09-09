// Netlify Function — public event-worker registration submission.
// No login required. Runs server-side against Neon's HTTP SQL endpoint directly
// (same dependency-free pattern as resolve-login.js) so it never depends on the
// Data API's anonymous-role path.
//
// Security posture:
// - Only ever INSERTs into event_applicants / increments a link counter.
// - Cannot read, list, or return any other applicant's data.
// - Age >= 18 and required-field checks are enforced here, not just client-side.
// - IBAN/mobile/ID are normalized before storage so duplicate detection is reliable.
//
// NOTE ON FILE STORAGE: no object storage (S3/R2/Supabase Storage) is connected
// to this project. As an interim measure, the compressed photo and IBAN proof
// are stored as base64 data URLs directly in Postgres text columns. This is a
// deliberate, disclosed trade-off — migrate to real object storage and swap the
// two INSERT columns for signed URLs once that's connected.

function sqlUrlFrom(dbUrl) {
  const u = new URL(dbUrl);
  return `https://${u.hostname.replace('-pooler', '')}/sql`;
}

async function runSql(dbUrl, query, params) {
  const r = await fetch(sqlUrlFrom(dbUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': dbUrl,
      'Neon-Raw-Text-Output': 'true',
      'Neon-Array-Mode': 'false'
    },
    body: JSON.stringify({ query, params })
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`db_error_${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

function normalize(s) {
  return String(s || '').toUpperCase().replace(/[\s\-]/g, '');
}

function ageAtLeast18(dobStr) {
  const dob = new Date(dobStr);
  if (isNaN(dob)) return false;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age >= 18;
}

function isDataUrlImage(s) {
  return typeof s === 'string' && /^data:image\/(png|jpeg|jpg|webp);base64,/.test(s) && s.length < 2_000_000;
}

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
  if (!dbUrl) return { statusCode: 500, headers, body: JSON.stringify({ error: 'DATABASE_URL not set' }) };

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: '{"error":"Invalid JSON"}' }; }

  const required = ['token','fullNameAr','fullNameEn','dob','mobile','idType','idNumber','iban','photo','ibanProof'];
  for (const f of required) {
    if (!p[f]) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing_field', field: f }) };
  }
  if (!ageAtLeast18(p.dob)) return { statusCode: 422, headers, body: JSON.stringify({ error: 'under_18' }) };
  if (!isDataUrlImage(p.photo) || !isDataUrlImage(p.ibanProof)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_attachment' }) };
  }

  try {
    const linkRes = await runSql(dbUrl,
      `SELECT id, owner_id, is_active, expires_at, max_applications, applications_count, event_id
       FROM event_registration_links WHERE token = $1 LIMIT 1`, [p.token]);
    const link = (linkRes.rows || [])[0];
    if (!link) return { statusCode: 404, headers, body: JSON.stringify({ error: 'link_not_found' }) };
    if (!link.is_active) return { statusCode: 403, headers, body: JSON.stringify({ error: 'link_inactive' }) };
    if (link.expires_at && new Date(link.expires_at) < new Date()) return { statusCode: 403, headers, body: JSON.stringify({ error: 'link_expired' }) };
    if (link.max_applications && link.applications_count >= link.max_applications) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'link_full' }) };
    }

    await runSql(dbUrl,
      `INSERT INTO event_applicants
        (owner_id, full_name_ar, full_name_en, date_of_birth, mobile, id_type, id_number,
         iqama_status, iqama_expiry, iban, mobile_norm, id_number_norm, iban_norm,
         photo_url, iban_proof_url, status, registration_link_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'new',$16)`,
      [link.owner_id, p.fullNameAr, p.fullNameEn, p.dob, p.mobile, p.idType, p.idNumber,
       p.iqamaStatus || null, p.iqamaExpiry || null, p.iban,
       normalize(p.mobile), normalize(p.idNumber), normalize(p.iban),
       p.photo, p.ibanProof, link.id]
    );

    await runSql(dbUrl, `UPDATE event_registration_links SET applications_count = applications_count + 1 WHERE id = $1`, [link.id]);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'submit_failed', detail: err.message }) };
  }
};
