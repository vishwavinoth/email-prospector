const axios = require('axios');
require('dotenv').config();

const BASE_URL = 'https://api.hunter.io/v2';

function getKey() {
  const key = process.env.HUNTER_API_KEY;
  if (!key || key === 'your_hunter_api_key_here') return null;
  return key;
}

async function domainSearch(domain) {
  const key = getKey();
  if (!key) {
    console.warn('[WARN] Hunter API key not set - skipping Hunter domain search');
    return [];
  }

  try {
    const res = await axios.get(`${BASE_URL}/domain-search`, {
      params: {
        domain,
        api_key: key,
        limit: 10,
        type: 'personal',
      },
      timeout: 10000,
    });

    const emails = (res.data?.data?.emails || []).map(email => ({
      email: email.value,
      firstName: email.first_name || '',
      lastName: email.last_name || '',
      role: email.position || '',
      department: email.department || '',
      confidence: email.confidence || 0,
      emailType: email.type || 'personal',
      source: 'hunter-domain-search',
    }));

    emails.sort((a, b) => b.confidence - a.confidence);
    return emails;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401) console.error('[ERROR] Hunter: Invalid API key');
    else if (status === 429) console.error('[ERROR] Hunter: Rate limit exceeded. Wait a minute.');
    else if (status === 422) console.error(`[ERROR] Hunter: Domain "${domain}" not valid`);
    else console.error(`[ERROR] Hunter domain search failed for ${domain}:`, err.message);
    return [];
  }
}

async function verifyEmail(email) {
  const key = getKey();
  if (!key) {
    return fallbackVerify(email);
  }

  try {
    const res = await axios.get(`${BASE_URL}/email-verifier`, {
      params: { email, api_key: key },
      timeout: 15000,
    });

    const data = res.data?.data || {};
    const isValid = data.status === 'valid' || (data.status === 'accept_all' && data.score >= 70);

    return {
      status: data.status || 'unknown',
      score: data.score || 0,
      isValid,
      reason: buildReason(data),
      mx_check: data.mx_records || false,
      smtp_ok: data.smtp_check || false,
    };
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429) {
      console.warn('[WARN] Hunter verify rate limit - using fallback DNS check');
      return fallbackVerify(email);
    }
    return { status: 'unknown', score: 0, isValid: false, reason: err.message };
  }
}

function buildReason(data) {
  const flags = [];
  if (data.mx_records === false) flags.push('no MX records');
  if (data.smtp_check === false) flags.push('SMTP rejected');
  if (data.disposable) flags.push('disposable email');
  if (data.webmail) flags.push('webmail address');
  if (data.gibberish) flags.push('gibberish address');
  return flags.length ? flags.join(', ') : data.status || 'ok';
}

async function fallbackVerify(email) {
  const dns = require('dns').promises;
  const domain = email.split('@')[1];
  if (!domain) return { status: 'invalid', score: 0, isValid: false, reason: 'bad format' };

  try {
    const records = await dns.resolveMx(domain);
    const hasMx = records && records.length > 0;
    return {
      status: hasMx ? 'accept_all' : 'invalid',
      score: hasMx ? 60 : 0,
      isValid: hasMx,
      reason: hasMx ? 'MX records found (DNS check only)' : 'no MX records',
      mx_check: hasMx,
      smtp_ok: false,
    };
  } catch {
    return {
      status: 'invalid',
      score: 0,
      isValid: false,
      reason: 'domain not found',
      mx_check: false,
      smtp_ok: false,
    };
  }
}

async function checkCredits() {
  const key = getKey();
  if (!key) return null;

  try {
    const res = await axios.get(`${BASE_URL}/account`, { params: { api_key: key } });
    const requests = res.data?.data?.requests;
    return {
      searchesUsed: requests?.searches?.used,
      searchesAvailable: requests?.searches?.available,
      verifiesUsed: requests?.verifications?.used,
      verifiesAvailable: requests?.verifications?.available,
    };
  } catch {
    return null;
  }
}

module.exports = { domainSearch, verifyEmail, checkCredits, fallbackVerify };
