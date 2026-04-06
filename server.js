require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { processBatch, processCompany, normalizeInput } = require('./prospector');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '3000', 10);
const BODY_LIMIT_BYTES = Math.max(
  1024,
  parseInt(process.env.WEBHOOK_BODY_LIMIT_BYTES || '1048576', 10)
);

function hasConfiguredValue(value) {
  const normalized = `${value || ''}`.trim();
  return Boolean(normalized) && !normalized.endsWith('_here');
}

function timestamp() {
  return new Date().toLocaleTimeString('en-IN');
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getApiKeyFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const headerValue = req.headers['x-api-key'];
  return typeof headerValue === 'string' ? headerValue.trim() : '';
}

function isAuthorized(req) {
  const expectedKey = (process.env.WEBHOOK_API_KEY || '').trim();
  if (!expectedKey) return true;

  const providedKey = getApiKeyFromRequest(req);
  return providedKey ? safeEqual(providedKey, expectedKey) : false;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let aborted = false;

    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        aborted = true;
        reject(new Error(`Request body exceeds ${BODY_LIMIT_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function makeRequestLogger(req) {
  const requestId = crypto.randomUUID().slice(0, 8);
  return {
    requestId,
    log: msg => log(`[${requestId}] ${req.method} ${req.url} ${msg}`),
    warn: msg => log(`[${requestId}] [WARN] ${req.method} ${req.url} ${msg}`),
    error: msg => log(`[${requestId}] [ERROR] ${req.method} ${req.url} ${msg}`),
  };
}

function validateProspectInput(body) {
  const input = normalizeInput(body);
  if (!input.websiteUrl && !input.gmbInfo) {
    throw new Error('websiteUrl or gmbInfo is required');
  }
  return input;
}

async function handleProspect(req, res) {
  const logger = makeRequestLogger(req);
  const startedAt = Date.now();

  try {
    const body = await readJsonBody(req);
    const input = validateProspectInput(body);
    logger.log(`started for ${input.companyName || input.websiteUrl || 'unknown company'}`);

    const results = await processCompany(input, { logger });
    sendJson(res, 200, {
      ok: true,
      mode: 'single',
      input,
      resultCount: results.length,
      results,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    logger.error(err.message);
    const statusCode = err.message === 'Invalid JSON body'
      ? 400
      : err.message.includes('exceeds')
        ? 413
        : 422;
    sendJson(res, statusCode, {
      ok: false,
      error: err.message,
    });
  }
}

async function handleBatch(req, res) {
  const logger = makeRequestLogger(req);
  const startedAt = Date.now();

  try {
    const body = await readJsonBody(req);
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items || items.length === 0) {
      throw new Error('items must be a non-empty array');
    }

    const sanitizedItems = items.map(validateProspectInput);
    const requestedConcurrency = parseInt(body.concurrency || process.env.WEBHOOK_BATCH_CONCURRENCY || '2', 10);
    const concurrency = Math.max(1, Math.min(requestedConcurrency, 10));

    logger.log(`batch started for ${sanitizedItems.length} item(s) with concurrency ${concurrency}`);
    const results = await processBatch(sanitizedItems, { concurrency, logger });

    sendJson(res, 200, {
      ok: true,
      mode: 'batch',
      itemCount: sanitizedItems.length,
      concurrency,
      results,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    logger.error(err.message);
    const statusCode = err.message === 'Invalid JSON body'
      ? 400
      : err.message.includes('exceeds')
        ? 413
        : 422;
    sendJson(res, statusCode, {
      ok: false,
      error: err.message,
    });
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'email-prospector',
        mode: 'webhook',
        features: {
          hunter: hasConfiguredValue(process.env.HUNTER_API_KEY),
          groq: hasConfiguredValue(process.env.GROQ_API_KEY),
          apiKeyProtection: hasConfiguredValue(process.env.WEBHOOK_API_KEY),
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (!isAuthorized(req)) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    if (req.method === 'POST' && url.pathname === '/prospect') {
      return handleProspect(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/prospect/batch') {
      return handleBatch(req, res);
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  });
}

function startServer(port = PORT, host = HOST) {
  const server = createServer();
  return new Promise(resolve => {
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      log(`Webhook server listening on http://${host}:${actualPort}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().catch(err => {
    log(`[ERROR] Failed to start server: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  createServer,
  startServer,
};
