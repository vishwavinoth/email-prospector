const axios = require('axios');
const cheerio = require('cheerio');
const groq = require('./groq');

const CONTACT_PATHS = [
  '/',
  '/contact',
  '/contact-us',
  '/about',
  '/about-us',
  '/team',
  '/our-team',
  '/people',
  '/leadership',
  '/management',
];

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

const DECISION_MAKER_KEYWORDS = [
  'ceo', 'cto', 'coo', 'cmo', 'cfo',
  'founder', 'co-founder', 'cofounder',
  'owner', 'director', 'head',
  'president', 'vp', 'vice president',
  'manager', 'managing',
  'chief', 'partner',
  'marketing', 'sales', 'business',
];

const EXCLUDE_PATTERNS = [
  /^(noreply|no-reply|donotreply|do-not-reply)@/i,
  /^(support|help|info|contact|admin|webmaster|postmaster|abuse|spam)@/i,
  /\.(png|jpg|gif|pdf|svg|css|js)$/i,
  /@(example|test|localhost|yourdomain|domain)\./i,
  /sentry\.|@w3\.org|@schema\.org/i,
];

function parseEnvInt(name, fallback) {
  const parsed = parseInt(process.env[name] || `${fallback}`, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampConfidence(value, fallback) {
  const parsed = Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(100, parsed));
}

function getGroqMode() {
  const mode = `${process.env.GROQ_MODE || 'fallback'}`.trim().toLowerCase();
  return mode === 'assist' ? 'assist' : 'fallback';
}

function getScrapedConfidence(emailType, role) {
  if (emailType === 'scraped_ai') {
    const defaultConfidence = parseEnvInt('SCRAPED_AI_CONFIDENCE', 75);
    const decisionMakerConfidence = parseEnvInt('SCRAPED_AI_DECISION_MAKER_CONFIDENCE', 85);
    return clampConfidence(
      isDecisionMakerRole(role) ? decisionMakerConfidence : defaultConfidence,
      75
    );
  }

  return clampConfidence(parseEnvInt('SCRAPED_CONFIDENCE', 50), 50);
}

function noopLogger() {
  return {
    log: () => {},
    warn: () => {},
    error: () => {},
  };
}

function isValidEmail(email) {
  return !EXCLUDE_PATTERNS.some(pattern => pattern.test(email));
}

function emailMatchesDomain(email, domain) {
  if (!domain) return true;

  const parts = `${email || ''}`.toLowerCase().split('@');
  if (parts.length !== 2) return false;

  const emailDomain = parts[1];
  const normalizedDomain = `${domain}`.toLowerCase();
  return emailDomain === normalizedDomain || emailDomain.endsWith(`.${normalizedDomain}`);
}

function normalizeUrl(url) {
  if (!url) return null;
  const trimmed = `${url}`.trim();
  if (!trimmed) return null;
  const withProtocol = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/$/, '');
}

function extractDomain(url) {
  try {
    return new URL(normalizeUrl(url)).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function fetchPage(url, timeoutMs = 10000) {
  try {
    const res = await axios.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OutreachBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      maxRedirects: 5,
    });
    return res.data || '';
  } catch {
    return '';
  }
}

function normalizeEmailishText(text) {
  return `${text || ''}`
    .replace(/&#64;/gi, '@')
    .replace(/&#46;/gi, '.')
    .replace(/\[\s*at\s*\]/gi, '@')
    .replace(/\(\s*at\s*\)/gi, '@')
    .replace(/\bat\b/gi, '@')
    .replace(/\[\s*dot\s*\]/gi, '.')
    .replace(/\(\s*dot\s*\)/gi, '.')
    .replace(/\bdot\b/gi, '.')
    .replace(/\s*@\s*/g, '@')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s+/g, ' ');
}

function extractEmailsFromText(text, domain) {
  if (!text) return [];

  const normalized = normalizeEmailishText(text);
  const found = normalized.match(EMAIL_REGEX) || [];

  return [...new Set(found)]
    .map(email => email.trim())
    .filter(isValidEmail)
    .filter(email => emailMatchesDomain(email, domain));
}

function extractEmailsFromHtml(html, domain) {
  return extractEmailsFromText(html, domain);
}

function extractVisibleText(html) {
  if (!html) return '';

  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();

  const text = $('body').text() || $.text();
  return normalizeEmailishText(text).trim();
}

function detectRole(text, email) {
  if (!text) return '';

  const lower = text.toLowerCase();
  const emailIdx = lower.indexOf(email.toLowerCase());
  if (emailIdx === -1) return '';

  const start = Math.max(0, emailIdx - 200);
  const end = Math.min(lower.length, emailIdx + 200);
  const context = lower.slice(start, end);

  for (const keyword of DECISION_MAKER_KEYWORDS) {
    if (context.includes(keyword)) return keyword;
  }

  return '';
}

function isDecisionMakerRole(role) {
  const lowerRole = `${role || ''}`.toLowerCase();
  return DECISION_MAKER_KEYWORDS.some(keyword => lowerRole.includes(keyword));
}

function isGroundedInPages(email, sourcePageUrl, pageSnapshots) {
  if (!email) return false;

  const exactPage = pageSnapshots.find(page => page.pageUrl === sourcePageUrl);
  if (exactPage) {
    return exactPage.text.toLowerCase().includes(email.toLowerCase());
  }

  return pageSnapshots.some(page => page.text.toLowerCase().includes(email.toLowerCase()));
}

async function scrapeWebsiteEmails(websiteUrl, options = {}) {
  const normalized = normalizeUrl(websiteUrl);
  if (!normalized) return [];

  const domain = extractDomain(websiteUrl);
  const logger = options.logger || noopLogger();
  const allEmails = new Map();
  const pageSnapshots = [];
  const delay = parseInt(process.env.SCRAPE_DELAY_MS || '2000', 10);
  const groqMode = getGroqMode();

  for (const pagePath of CONTACT_PATHS) {
    const pageUrl = `${normalized}${pagePath}`;
    const html = await fetchPage(pageUrl);
    if (!html) continue;

    const visibleText = extractVisibleText(html);
    if (visibleText) {
      pageSnapshots.push({
        pageUrl,
        text: visibleText,
      });
    }

    const emails = extractEmailsFromHtml(html, domain);

    for (const email of emails) {
      if (allEmails.has(email)) continue;

      const role = detectRole(visibleText || html, email);
      allEmails.set(email, {
        email,
        role,
        source: pageUrl,
        emailType: 'scraped',
        isDecisionMaker: isDecisionMakerRole(role),
        confidence: getScrapedConfidence('scraped', role),
      });
    }

    await new Promise(resolve => setTimeout(resolve, delay));
  }

  const shouldRunGroq = groq.isEnabled() && pageSnapshots.length > 0 && (
    groqMode === 'assist' || allEmails.size === 0
  );

  if (shouldRunGroq) {
    logger.log(
      `  Groq ${groqMode === 'assist' ? 'assist' : 'fallback'} analyzing ${pageSnapshots.length} page(s) for ${domain || normalized}`
    );

    const aiContacts = await groq.extractContactsFromPages({
      domain,
      pages: pageSnapshots,
    });

    let aiAdded = 0;

    for (const contact of aiContacts) {
      const email = `${contact.email || ''}`.trim().toLowerCase();
      if (!email || allEmails.has(email) || !isValidEmail(email)) continue;
      if (!isGroundedInPages(email, contact.sourcePageUrl, pageSnapshots)) continue;

      const role = `${contact.role || ''}`.trim();
      allEmails.set(email, {
        email,
        role,
        source: contact.sourcePageUrl || normalized,
        emailType: 'scraped_ai',
        isDecisionMaker: isDecisionMakerRole(role),
        confidence: getScrapedConfidence('scraped_ai', role),
      });
      aiAdded += 1;
    }

    if (aiAdded > 0) {
      logger.log(`  Groq added ${aiAdded} grounded email(s)`);
    }
  }

  const results = [...allEmails.values()];
  results.sort((left, right) => (right.isDecisionMaker ? 1 : 0) - (left.isDecisionMaker ? 1 : 0));

  return results;
}

module.exports = {
  scrapeWebsiteEmails,
  extractDomain,
  normalizeUrl,
  extractEmailsFromText,
};
