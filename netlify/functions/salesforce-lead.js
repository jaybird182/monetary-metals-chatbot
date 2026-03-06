const TOKEN_ENDPOINT = 'https://test.salesforce.com/services/oauth2/token';
const LEAD_SOURCE = 'MM Chatbot';
const COMPANY_NAME = 'Monetary Metals Chatbot';

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

function escapeSoql(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function formatTranscriptSection({ timestamp, sessionEvent, transcript, questionCount }) {
  if (!transcript || !transcript.trim()) return '';

  const label = sessionEvent === 'session_end' ? 'Session End Transcript' : 'Form Submit Transcript';
  return [
    `[${timestamp}] ${label}`,
    `Question Count: ${questionCount || 0}`,
    transcript.trim()
  ].join('\n');
}

function appendDescription(existingDescription, transcriptSection) {
  if (!transcriptSection) return existingDescription || '';
  return existingDescription ? `${existingDescription}\n\n${transcriptSection}` : transcriptSection;
}

async function getAccessToken() {
  const {
    SALESFORCE_CLIENT_ID,
    SALESFORCE_CLIENT_SECRET,
    SALESFORCE_USERNAME,
    SALESFORCE_PASSWORD,
    SALESFORCE_SECURITY_TOKEN
  } = process.env;

  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: SALESFORCE_CLIENT_ID || '',
    client_secret: SALESFORCE_CLIENT_SECRET || '',
    username: SALESFORCE_USERNAME || '',
    password: `${SALESFORCE_PASSWORD || ''}${SALESFORCE_SECURITY_TOKEN || ''}`
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const data = await res.json();

  if (!res.ok || !data.access_token || !data.instance_url) {
    throw new Error(`Salesforce auth failed: ${data.error_description || data.error || res.status}`);
  }

  return data;
}

async function salesforceQuery(instanceUrl, accessToken, soql) {
  const url = `${instanceUrl}/services/data/v61.0/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Salesforce query failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function createLead(instanceUrl, accessToken, payload) {
  const res = await fetch(`${instanceUrl}/services/data/v61.0/sobjects/Lead`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Salesforce create failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function updateLead(instanceUrl, accessToken, leadId, payload) {
  const res = await fetch(`${instanceUrl}/services/data/v61.0/sobjects/Lead/${leadId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce update failed: ${text}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return response(200, { ok: true });
  }

  if (event.httpMethod !== 'POST') {
    return response(405, { error: 'Method not allowed' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const firstName = (body.firstName || '').trim();
    const lastName = (body.lastName || '').trim();
    const email = (body.email || '').trim().toLowerCase();
    const sessionEvent = (body.sessionEvent || 'form_submit').trim();
    const questions = Array.isArray(body.questions)
      ? body.questions.map((q) => String(q || '').trim()).filter(Boolean)
      : [];
    const providedQuestionCount = Number(body.questionCount);
    const questionCount = Number.isFinite(providedQuestionCount) ? providedQuestionCount : questions.length;
    const transcript = typeof body.transcript === 'string' && body.transcript.trim()
      ? body.transcript.trim()
      : questions.map((q) => `- ${q}`).join('\n');
    const timestamp = (body.timestamp || new Date().toISOString()).trim();

    if (!firstName || !lastName || !email) {
      return response(400, { error: 'firstName, lastName, and email are required' });
    }

    const auth = await getAccessToken();
    const instanceUrl = process.env.SALESFORCE_INSTANCE_URL || auth.instance_url;
    const accessToken = auth.access_token;

    const query = `SELECT Id, Email, Description FROM Lead WHERE Email = '${escapeSoql(email)}' LIMIT 1`;
    const result = await salesforceQuery(instanceUrl, accessToken, query);

    const transcriptSection = formatTranscriptSection({
      timestamp,
      sessionEvent,
      transcript,
      questionCount: questions.length || questionCount
    });

    const payload = {
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      Company: COMPANY_NAME,
      LeadSource: LEAD_SOURCE
    };

    if (result.totalSize > 0 && result.records?.[0]?.Id) {
      const lead = result.records[0];
      const leadId = lead.Id;
      await updateLead(instanceUrl, accessToken, leadId, {
        ...payload,
        ...(transcriptSection ? { Description: appendDescription(lead.Description, transcriptSection) } : {})
      });
      return response(200, {
        ok: true,
        action: 'updated',
        leadId,
        transcriptAppended: !!transcriptSection,
        sessionEvent
      });
    }

    const created = await createLead(instanceUrl, accessToken, {
      ...payload,
      ...(transcriptSection ? { Description: transcriptSection } : {})
    });
    return response(200, {
      ok: true,
      action: 'created',
      leadId: created.id,
      transcriptAppended: !!transcriptSection,
      sessionEvent
    });
  } catch (error) {
    console.error('salesforce-lead error', error);
    return response(500, { error: error.message || 'Internal server error' });
  }
};
