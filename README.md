# Email Prospector

Minimal Node.js API for `n8n` that finds public company emails from:

- website scraping
- optional Hunter domain search
- optional Groq grounded extraction in `fallback` or `assist` mode
- direct email mentions inside `GMB Info`

This repo is now centered on one final `n8n` workflow:

- `examples/n8n-email-prospector-final-workflow.json`

Use that workflow if you want the Google Sheets -> Email Prospector -> Google Sheets flow.

## What The Final Workflow Does

The final workflow reads rows from an input Google Sheet, normalizes each row, sends it to `POST /prospect`, splits the returned `results[]`, and upserts one output row per result into your output Google Sheet.

Flow:

1. Read rows from the input sheet
2. Skip rows already marked as processed
3. Normalize `Company Name`, `Website URL`, and `GMB Info`
4. Call the Email Prospector API
5. Split `results[]`
6. Upsert one row per result into the output sheet using a stable `Result Key`

## Local Setup

1. Install dependencies:

```powershell
npm install
```

2. Copy `.env.example` to `.env`

3. Set your values in `.env`

Recommended minimum:

```env
HOST=0.0.0.0
PORT=3000
WEBHOOK_API_KEY=
HUNTER_API_KEY=
GROQ_API_KEY=
GROQ_MODE=assist
```

Notes:

- `WEBHOOK_API_KEY` is optional. If set, `n8n` must send it in `X-API-Key` or `Authorization: Bearer ...`.
- `HUNTER_API_KEY` is optional. Without it, verification falls back to DNS / MX checks.
- `GROQ_API_KEY` is optional. Without it, the scraper uses only deterministic extraction.
- `GROQ_MODE=assist` makes Groq analyze crawled pages even when regex scraping already found emails.

4. Start the API:

```powershell
npm start
```

5. Check health:

```text
GET http://127.0.0.1:3000/health
```

Expected result:

```json
{
  "ok": true
}
```

## n8n Final Workflow Setup

Import this file into `n8n`:

- `examples/n8n-email-prospector-final-workflow.json`

After import, open the `Workflow Config` node and set:

- `inputSpreadsheetId`
- `inputSheetName`
- `outputSpreadsheetId`
- `outputSheetName`
- `prospectorUrl`
- `webhookApiKey`

Recommended values:

- `inputSheetName` = `Input`
- `outputSheetName` = `Output`
- `prospectorUrl` = `http://127.0.0.1:3000/prospect` for local use

If your API is deployed publicly, use your public URL instead, for example:

```text
https://your-domain.com/prospect
```

Then attach your Google Sheets credential to these nodes:

- `Get Input Rows`
- `Append Output Row`

Run the workflow with `Test workflow`.

## Google Sheets Format

Input sheet headers:

```text
Company Name | Website URL | GMB Info | Status | Processed | Processed At
```

Output sheet headers:

```text
Result Key | Input Row Number | Company Name | Website URL | GMB Info | Email | First Name | Last Name | Role / Title | Department | Confidence Score | Verification Status | Email Type | Source | Found At
```

Ready-to-use templates:

- `examples/google-sheets-input-template.csv`
- `examples/google-sheets-output-template.csv`

## Accepted Input Fields

The API accepts these aliases:

- `companyName`, `company`, `name`
- `websiteUrl`, `website`, `url`
- `gmbInfo`, `gmb`, `notes`

At least one of these must be present:

- `websiteUrl`
- `gmbInfo`

Rows are skipped by the workflow if any of these input columns indicate they are already processed:

- `Status` = `processed`, `done`, `completed`, or `success`
- `Processed` = `true`, `yes`, `y`, or `1`
- `Processed At` has any value

## API Endpoints

- `GET /health`
- `POST /prospect`
- `POST /prospect/batch`

### `POST /prospect` Request

```json
{
  "companyName": "Acme Corp",
  "websiteUrl": "https://acme.com",
  "gmbInfo": "Optional notes from Google Maps or manual research"
}
```

### `POST /prospect` Response

```json
{
  "ok": true,
  "mode": "single",
  "input": {
    "companyName": "Acme Corp",
    "websiteUrl": "https://acme.com",
    "gmbInfo": "Optional notes from Google Maps or manual research"
  },
  "resultCount": 1,
  "results": [
    {
      "companyName": "Acme Corp",
      "websiteUrl": "https://acme.com",
      "gmbInfo": "Optional notes from Google Maps or manual research",
      "email": "founder@acme.com",
      "firstName": "",
      "lastName": "",
      "role": "founder",
      "department": "",
      "confidence": 50,
      "verifyStatus": "accept_all",
      "emailType": "scraped",
      "source": "https://acme.com/contact"
    }
  ]
}
```

## Result Fields

| Field | Meaning |
| --- | --- |
| `companyName` | Company name from the request |
| `websiteUrl` | Website URL from the request |
| `gmbInfo` | Input notes / Google Maps notes |
| `email` | Found email address |
| `firstName` | First name if Hunter provides one |
| `lastName` | Last name if Hunter provides one |
| `role` | Role or title near the email |
| `department` | Department if available |
| `confidence` | Confidence score |
| `verifyStatus` | `valid`, `accept_all`, `invalid`, `unknown`, or `N/A` |
| `emailType` | `personal`, `generic`, `scraped`, `scraped_ai`, `gmb`, or `unknown` |
| `source` | Where the email came from |

The output sheet also stores:

- `Result Key`: unique key used by the workflow to upsert rows instead of duplicating them on reruns
- `Input Row Number`: row number returned by the Google Sheets read step

## Groq Without Hunter

If you want a Groq-assisted setup without Hunter, use:

```env
HUNTER_API_KEY=
GROQ_API_KEY=your_real_groq_api_key
GROQ_MODEL=llama-3.1-8b-instant
GROQ_MODE=assist
SCRAPED_CONFIDENCE=50
SCRAPED_AI_CONFIDENCE=75
SCRAPED_AI_DECISION_MAKER_CONFIDENCE=85
```

Behavior:

1. The app still crawls the website first
2. Groq reads the crawled page text and returns only grounded emails
3. Groq results are merged with scraped results
4. `scraped_ai` results use their own confidence values

Check `GET /health` after restart. You should see:

```json
{
  "features": {
    "hunter": false,
    "groq": true,
    "groqMode": "assist"
  }
}
```

## Deploy On Render

This repo includes:

- `render.yaml`

Basic Render setup:

1. Create a new Web Service or Blueprint from this repo
2. Keep `HOST=0.0.0.0`
3. Set `WEBHOOK_API_KEY` if you want API protection
4. Set `HUNTER_API_KEY` and `GROQ_API_KEY` only if you want those optional features
5. Use the deployed `/prospect` URL in the `Workflow Config` node inside `n8n`

## Troubleshooting

### `401 Unauthorized`

If `WEBHOOK_API_KEY` is set, send the same value from `n8n` in:

- `X-API-Key`
- or `Authorization: Bearer <key>`

### `No rows were processed`

The workflow skips rows where both of these are empty:

- `Website URL`
- `GMB Info`

It also skips rows already marked as processed using:

- `Status`
- `Processed`
- `Processed At`

### `n8n cannot reach localhost`

If `n8n` is running on another server, container, or cloud account, do not use `localhost`.

Use a public URL like:

```text
https://your-domain.com/prospect
```

### Hunter key issues

Put only the raw API key in `HUNTER_API_KEY`.

Do not paste a full URL like:

```text
https://api.hunter.io/...
```

### `access to env vars denied` inside n8n

This final workflow does not depend on `$env` expressions inside `n8n`.

Set your values directly in the `Workflow Config` node instead.
