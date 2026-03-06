const TOKEN_ENDPOINT = 'https://test.salesforce.com/services/oauth2/token';

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

    if (!firstName || !lastName || !email) {
      return response(400, { error: 'firstName, lastName, and email are required' });
    }

    const auth = await getAccessToken();
    const instanceUrl = process.env.SALESFORCE_INSTANCE_URL || auth.instance_url;
    const accessToken = auth.access_token;

    const query = `SELECT Id, Email FROM Lead WHERE Email = '${email.replace(/'/g, "\\'")}' LIMIT 1`;
    const result = await salesforceQuery(instanceUrl, accessToken, query);

    const payload = {
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      Company: 'Monetary Metals Chatbot',
      LeadSource: 'MM Chatbot'
    };

    if (result.totalSize > 0 && result.records?.[0]?.Id) {
      const leadId = result.records[0].Id;
      await updateLead(instanceUrl, accessToken, leadId, payload);
      return response(200, { ok: true, action: 'updated', leadId });
    }

    const created = await createLead(instanceUrl, accessToken, payload);
    return response(200, { ok: true, action: 'created', leadId: created.id });
  } catch (error) {
    console.error('salesforce-lead error', error);
    return response(500, { error: error.message || 'Internal server error' });
  }
};
