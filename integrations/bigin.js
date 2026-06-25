// Bigin (Zoho CRM) integration — push leads, deals, and outcomes from the bot.
//
// Auth: OAuth 2.0 refresh-token flow. Required env vars:
//   BIGIN_CLIENT_ID, BIGIN_CLIENT_SECRET, BIGIN_REFRESH_TOKEN, BIGIN_DC
//
// BIGIN_DC values:
//   "in"  → India accounts (zoho.in)
//   "com" → US accounts (zoho.com)
//   "eu"  → EU accounts (zoho.eu)
//   "com.au", "jp", etc. — see Zoho docs
//
// Feature flag: BIGIN_ENABLED=true to activate. Defaults off so missing creds don't break the bot.

const axios = require('axios');

const TOKEN_TTL_MS = 50 * 60 * 1000; // tokens are 1h, refresh at 50m
let cachedToken = null;
let tokenExpiresAt = 0;

function isConfigured() {
  return !!(
    process.env.BIGIN_ENABLED === 'true' &&
    process.env.BIGIN_CLIENT_ID &&
    process.env.BIGIN_CLIENT_SECRET &&
    process.env.BIGIN_REFRESH_TOKEN
  );
}

function dc() {
  return (process.env.BIGIN_DC || 'in').trim();
}

function apiBase() {
  return `https://www.zohoapis.${dc()}/bigin/v2`;
}

function accountsBase() {
  return `https://accounts.zoho.${dc()}`;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const params = new URLSearchParams({
    refresh_token: process.env.BIGIN_REFRESH_TOKEN,
    client_id: process.env.BIGIN_CLIENT_ID,
    client_secret: process.env.BIGIN_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });

  try {
    const res = await axios.post(
      `${accountsBase()}/oauth/v2/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );
    if (!res.data?.access_token) {
      throw new Error('No access_token in refresh response');
    }
    cachedToken = res.data.access_token;
    tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    return cachedToken;
  } catch (err) {
    console.error('❌ Bigin token refresh failed:', err.response?.data || err.message);
    throw err;
  }
}

async function biginRequest(method, path, data) {
  const token = await getAccessToken();
  const res = await axios({
    method,
    url: `${apiBase()}${path}`,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json'
    },
    data,
    timeout: 10000
  });
  return res.data;
}

// Auto-discover the Bigin org's first Pipeline + Sub_Pipeline so we don't need to
// hardcode IDs. Cached forever (per-process) since pipeline metadata rarely changes.
// Returns { Pipeline: {id, name}, Sub_Pipeline: 'actual_value' } or null on failure.
let cachedPipelineMeta = null;

async function getPipelineMeta() {
  if (cachedPipelineMeta) return cachedPipelineMeta;

  // Try the v2 settings endpoint that returns pipelines + their sub-pipelines
  const endpoints = ['/settings/pipelines', '/settings/layouts?module=Pipelines'];
  for (const ep of endpoints) {
    try {
      const data = await biginRequest('GET', ep);
      // Response shape varies: try both possible top-level keys
      const list = data?.pipelines || data?.layouts || data?.pipeline || [];
      const first = Array.isArray(list) ? list[0] : null;
      if (!first?.id) continue;

      const subList = first.sub_pipelines || [];
      const firstSub = subList[0];

      cachedPipelineMeta = {
        Pipeline: { id: first.id, name: first.name || first.display_label || 'Sales Pipeline' },
        Sub_Pipeline: firstSub?.actual_value || firstSub?.display_value || 'Sales Pipeline Standard'
      };
      console.log('✅ Bigin pipeline discovered:', JSON.stringify(cachedPipelineMeta));
      return cachedPipelineMeta;
    } catch (err) {
      console.warn(`⚠️ Bigin pipeline discovery failed at ${ep}:`,
        err.response?.status, err.response?.data?.code || err.message);
    }
  }
  return null;
}

// Search Contact by phone. Returns contact object or null.
async function findContactByPhone(phone) {
  try {
    const data = await biginRequest('GET', `/Contacts/search?phone=${encodeURIComponent(phone)}`);
    if (data?.data?.length > 0) {
      return data.data[0];
    }
    return null;
  } catch (err) {
    if (err.response?.status === 204) return null; // No content = not found
    console.warn('⚠️ Bigin contact search failed:', err.response?.data || err.message);
    return null;
  }
}

async function createContact({ phone, lastName, firstName, email }) {
  const payload = {
    data: [{
      Last_Name: lastName || phone || 'WhatsApp Lead',
      First_Name: firstName || undefined,
      Phone: phone,
      Mobile: phone,
      Email: email || undefined,
      Lead_Source: 'WhatsApp Bot'
    }]
  };
  try {
    const data = await biginRequest('POST', '/Contacts', payload);
    const created = data?.data?.[0];
    if (created?.status === 'success') return created.details;
    console.warn('⚠️ Bigin contact create returned non-success:', created);
    return null;
  } catch (err) {
    console.error('❌ Bigin contact create failed:', err.response?.data || err.message);
    return null;
  }
}

async function findOrCreateContact({ phone, name }) {
  const existing = await findContactByPhone(phone);
  if (existing) return existing;
  return createContact({ phone, lastName: name });
}

// Find open Deal for a contact, or null. Used so we update the same Deal instead of duplicating.
// Bigin's related-list endpoint requires the `fields` query param (live API enforces it
// even though docs say optional). The related-list path uses the legacy alias `Deals`.
async function findOpenDealForContact(contactId) {
  try {
    const fields = 'Deal_Name,Stage,Amount,Pipeline,Sub_Pipeline';
    const data = await biginRequest('GET', `/Contacts/${contactId}/Deals?fields=${fields}`);
    if (data?.data?.length > 0) {
      const open = data.data.find(d =>
        d.Stage !== 'Closed Won' &&
        d.Stage !== 'Closed Lost'
      );
      return open || null;
    }
    return null;
  } catch (err) {
    if (err.response?.status === 204) return null;
    console.warn('⚠️ Bigin find deal failed:', err.response?.data || err.message);
    return null;
  }
}

async function createDeal({ contactId, dealName, amount, stage, products, notes }) {
  // Bigin Pipelines require Closing_Date (mandatory in the deal/pipeline schema).
  // Default to 30 days out — the bot doesn't know the real close date yet.
  const closingDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  // Bigin v2 requires Pipeline as {id, name} object + Sub_Pipeline as the FULL
  // actual_value string (e.g. "Sales Pipeline Standard"). Auto-discover via the
  // /settings/pipelines endpoint so we never need hardcoded IDs.
  const meta = await getPipelineMeta();
  const pipeline = meta?.Pipeline || (process.env.BIGIN_PIPELINE_ID
    ? { id: process.env.BIGIN_PIPELINE_ID, name: process.env.BIGIN_PIPELINE_NAME || 'Sales Pipeline' }
    : undefined);
  const subPipeline = meta?.Sub_Pipeline || process.env.BIGIN_SUB_PIPELINE || 'Sales Pipeline Standard';

  const payload = {
    data: [{
      Deal_Name: dealName,
      Stage: stage || 'Qualification',
      ...(pipeline ? { Pipeline: pipeline } : {}),
      Sub_Pipeline: subPipeline,
      Amount: amount || 0,
      Contact_Name: { id: contactId },
      Closing_Date: closingDate,
      Description: [
        products?.length ? `Products: ${products.join(', ')}` : null,
        notes
      ].filter(Boolean).join('\n')
    }]
  };
  try {
    // Bigin's primary deal module is `Pipelines`, NOT `Deals`. The `/Deals` URL pattern
    // works only as a related-list alias under /Contacts/{id}/Deals — POST/PUT must use /Pipelines.
    const data = await biginRequest('POST', '/Pipelines', payload);
    const created = data?.data?.[0];
    if (created?.status === 'success') return created.details;
    console.warn('⚠️ Bigin deal create returned non-success:', JSON.stringify(created));
    return null;
  } catch (err) {
    // JSON.stringify so nested `details` objects show up instead of `[Object]`
    console.error('❌ Bigin deal create failed:', JSON.stringify(err.response?.data || err.message));
    return null;
  }
}

async function updateDealStage(dealId, stage) {
  try {
    const data = await biginRequest('PUT', `/Pipelines/${dealId}`, {
      data: [{ Stage: stage }]
    });
    return data?.data?.[0]?.status === 'success';
  } catch (err) {
    console.error('❌ Bigin deal update failed:', err.response?.data || err.message);
    return false;
  }
}

// MAIN ENTRY POINT — called from server.js when a lead-relevant event happens.
//
// event.type: 'quoted' | 'sale' | 'no_sale' | 'abandoned'
// event.phone: customer phone (string, no +)
// event.amount: order value in INR (number, optional)
// event.products: array of product strings (optional)
// event.dealName: short description (optional, e.g. "WhatsApp: 300 diaries")
// event.notes: conversation summary (optional)
//
// Returns { success: true } on success, { success: false, reason } otherwise.
// NEVER throws — silently degrades if Bigin is unreachable, so bot keeps working.
async function pushLeadEvent(event) {
  if (!isConfigured()) {
    return { success: false, reason: 'Bigin not configured' };
  }

  try {
    const contact = await findOrCreateContact({ phone: event.phone, name: event.name });
    if (!contact?.id) {
      return { success: false, reason: 'Could not resolve Bigin contact' };
    }

    const stageMap = {
      quoted: 'Qualification',
      proposal: 'Proposal/Price Quote',
      sale: 'Closed Won',
      no_sale: 'Closed Lost',
      abandoned: 'Closed Lost'
    };
    const stage = stageMap[event.type] || 'Qualification';

    const existing = await findOpenDealForContact(contact.id);

    if (existing) {
      // Update existing open deal
      if (event.type === 'sale' || event.type === 'no_sale' || event.type === 'abandoned') {
        await updateDealStage(existing.id, stage);
        return { success: true, dealId: existing.id, action: 'closed' };
      }
      // For 'quoted', just keep the existing open deal as-is
      return { success: true, dealId: existing.id, action: 'kept' };
    }

    // Create new deal
    const deal = await createDeal({
      contactId: contact.id,
      dealName: event.dealName || `WhatsApp Lead — ${event.phone}`,
      amount: event.amount || 0,
      stage,
      products: event.products,
      notes: event.notes
    });

    if (!deal?.id) {
      return { success: false, reason: 'Deal create failed' };
    }
    return { success: true, dealId: deal.id, action: 'created' };
  } catch (err) {
    console.error('❌ Bigin pushLeadEvent failed:', err.message);
    return { success: false, reason: err.message };
  }
}

module.exports = { pushLeadEvent, isConfigured };
