require('dotenv').config();

const pLimit = require('p-limit');
const scraper = require('./scraper');
const hunter = require('./hunter');

function timestamp() {
  return new Date().toLocaleTimeString('en-IN');
}

function defaultLogger() {
  return {
    log: msg => console.log(`[${timestamp()}] ${msg}`),
    warn: msg => console.warn(`[${timestamp()}] [WARN] ${msg}`),
    error: msg => console.error(`[${timestamp()}] [ERROR] ${msg}`),
  };
}

function normalizeInput(row = {}) {
  return {
    companyName: `${row.companyName || row.company || row.name || ''}`.trim(),
    websiteUrl: `${row.websiteUrl || row.website || row.url || ''}`.trim(),
    gmbInfo: `${row.gmbInfo || row.gmb || row.notes || ''}`.trim(),
  };
}

function isSameEmail(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

async function processCompany(rawRow, options = {}) {
  const row = normalizeInput(rawRow);
  const { companyName, websiteUrl, gmbInfo } = row;
  const logger = options.logger || defaultLogger();

  logger.log(`Processing: ${companyName || websiteUrl || 'unknown company'}`);

  const domain = scraper.extractDomain(websiteUrl);
  const emailCandidates = [];

  if (domain) {
    const hunterEmails = await hunter.domainSearch(domain);
    if (hunterEmails.length > 0) {
      logger.log(`  Hunter found ${hunterEmails.length} email(s) for ${domain}`);
      emailCandidates.push(...hunterEmails);
    }
  }

  if (websiteUrl) {
    const scraped = await scraper.scrapeWebsiteEmails(websiteUrl, { logger });
    if (scraped.length > 0) {
      logger.log(`  Scraped ${scraped.length} email(s) from ${websiteUrl}`);

      for (const scrapedEmail of scraped) {
        const exists = emailCandidates.find(candidate => isSameEmail(candidate.email, scrapedEmail.email));
        if (!exists) {
          emailCandidates.push({
            email: scrapedEmail.email,
            firstName: '',
            lastName: '',
            role: scrapedEmail.role || '',
            department: '',
            confidence: typeof scrapedEmail.confidence === 'number' ? scrapedEmail.confidence : 50,
            emailType: scrapedEmail.emailType || 'scraped',
            source: scrapedEmail.source,
          });
        }
      }
    }
  }

  if (gmbInfo) {
    const gmbEmails = gmbInfo.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
    for (const email of gmbEmails) {
      const exists = emailCandidates.find(candidate => isSameEmail(candidate.email, email));
      if (!exists) {
        emailCandidates.push({
          email,
          firstName: '',
          lastName: '',
          role: '',
          department: '',
          confidence: 40,
          emailType: 'gmb',
          source: 'GMB Profile',
        });
      }
    }
  }

  if (emailCandidates.length === 0) {
    logger.warn(`  No emails found for ${companyName || websiteUrl || 'unknown company'}`);
    return [{
      companyName,
      websiteUrl,
      gmbInfo,
      email: 'NOT FOUND',
      firstName: '',
      lastName: '',
      role: '',
      department: '',
      confidence: null,
      verifyStatus: 'N/A',
      emailType: '',
      source: '',
    }];
  }

  const results = [];

  for (const candidate of emailCandidates) {
    const verify = await hunter.verifyEmail(candidate.email);
    logger.log(`  ${candidate.email} -> ${verify.status} (score: ${verify.score})`);

    if (verify.status === 'invalid' && verify.score < 20) {
      logger.warn(`  Skipping invalid email: ${candidate.email}`);
      continue;
    }

    results.push({
      companyName,
      websiteUrl,
      gmbInfo,
      email: candidate.email,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      role: candidate.role,
      department: candidate.department,
      confidence: candidate.confidence,
      verifyStatus: verify.status,
      emailType: candidate.emailType || 'unknown',
      source: candidate.source || '',
    });

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (results.length > 0) {
    return results;
  }

  return [{
    companyName,
    websiteUrl,
    gmbInfo,
    email: 'ALL INVALID',
    firstName: '',
    lastName: '',
    role: '',
    department: '',
    confidence: null,
    verifyStatus: 'invalid',
    emailType: '',
    source: '',
  }];
}

async function processBatch(rows, options = {}) {
  const concurrency = Math.max(1, parseInt(options.concurrency || process.env.CONCURRENCY || '2', 10));
  const limit = pLimit(concurrency);
  const logger = options.logger || defaultLogger();
  const items = rows.map(row => normalizeInput(row));

  return Promise.all(items.map(item => limit(async () => ({
    input: item,
    results: await processCompany(item, { logger }),
  }))));
}

module.exports = {
  processBatch,
  processCompany,
  normalizeInput,
  defaultLogger,
};
