const axios = require('axios');

const CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const MAX_PAGES = 4;
const MAX_CHARS_PER_PAGE = 5000;

function getKey() {
  const key = `${process.env.GROQ_API_KEY || ''}`.trim();
  return key || null;
}

function isEnabled() {
  return Boolean(getKey());
}

function truncate(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function parseStructuredJson(raw) {
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function sanitizeContacts(rawContacts) {
  if (!Array.isArray(rawContacts)) return [];

  const seen = new Set();
  const contacts = [];

  for (const rawContact of rawContacts) {
    const email = `${rawContact?.email || ''}`.trim().toLowerCase();
    if (!email || seen.has(email)) continue;

    seen.add(email);
    contacts.push({
      email,
      role: `${rawContact?.role || ''}`.trim(),
      sourcePageUrl: `${rawContact?.sourcePageUrl || ''}`.trim(),
      evidenceSnippet: `${rawContact?.evidenceSnippet || ''}`.trim(),
    });
  }

  return contacts;
}

async function extractContactsFromPages({ domain, pages }) {
  const apiKey = getKey();
  if (!apiKey) return [];

  const preparedPages = Array.isArray(pages)
    ? pages
      .filter(page => page && page.pageUrl && page.text)
      .slice(0, MAX_PAGES)
      .map(page => ({
        sourcePageUrl: page.pageUrl,
        text: truncate(page.text, MAX_CHARS_PER_PAGE),
      }))
    : [];

  if (preparedPages.length === 0) return [];

  try {
    const res = await axios.post(
      CHAT_COMPLETIONS_URL,
      {
        model: DEFAULT_MODEL,
        temperature: 0,
        max_completion_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'Extract only grounded company contact emails from the provided webpage text.',
              'Return one JSON object with a "contacts" array.',
              'Each contact must include email, role, sourcePageUrl, and evidenceSnippet.',
              'Never invent or guess an address from the domain.',
              'Only include emails that are explicitly present or clearly deobfuscated from the text itself.',
              'If no grounded emails are present, return {"contacts":[]}.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              domain: domain || '',
              pages: preparedPages,
            }),
          },
        ],
      },
      {
        timeout: 20000,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
      }
    );

    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = parseStructuredJson(content);
    return sanitizeContacts(parsed?.contacts);
  } catch {
    return [];
  }
}

module.exports = {
  extractContactsFromPages,
  isEnabled,
};
