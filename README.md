# Email Prospector

Minimal Node.js API for `n8n` that finds public company emails from:

- website scraping
- optional Hunter domain search
- optional Groq fallback when scraping finds nothing
- direct email mentions inside `GMB Info`

This repo is now centered on one final `n8n` workflow:

- `examples/n8n-email-prospector-final-workflow.json`

Use that workflow if you want the Google Sheets -> Email Prospector -> Google Sheets flow.

## What The Final Workflow Does

The final workflow reads rows from an input Google Sheet, normalizes each row, sends it to `POST /prospect`, splits the returned `results[]`, and appends one output row per result into your output Google Sheet.

Flow:

1. Read rows from the input sheet
2. Normalize `Company Name`, `Website URL`, and `GMB Info`
3. Call the Email Prospector API
4. Split `results[]`
5. Append one row per result into the output sheet

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
```

Notes:

- `WEBHOOK_API_KEY` is optional. If set, `n8n` must send it in `X-API-Key` or `Authorization: Bearer ...`.
- `HUNTER_API_KEY` is optional. Without it, verification falls back to DNS / MX checks.
- `GROQ_API_KEY` is optional. Without it, the scraper uses only deterministic extraction.

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
Company Name | Website URL | GMB Info
```

Output sheet headers:

```text
Company Name | Website URL | GMB Info | Email | First Name | Last Name | Role / Title | Department | Confidence Score | Verification Status | Email Type | Source | Found At
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
