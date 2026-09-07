const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dtcrxnxhpwhmlciolkrr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

module.exports = async function handler(req, res) {
  // 1. Allow both POST and PATCH
  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { token, message_id: queryMessageId } = req.query;
  const body = req.body || {};

  // 2. Validate Token with Supabase
  const { data, error } = await supabase
    .from('webhooks')
    .select('discord_webhook_url')
    .eq('proxy_token', token)
    .single();

  if (error || !data) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // 3. Validation Logic ("RAYZ HUB On Top")
  let secure = false;
  try {
    if (body.content && !body.embeds) {
      return res.status(400).json({ error: 'access denied' });
    }

    if (body.embeds && body.embeds[0]) {
      const embed = body.embeds[0];
      const fields = embed.fields || [];
      const footerText = (embed.footer && embed.footer.text) ? embed.footer.text : "";

      if (fields.length <= 6 && footerText.includes('Status Hub On Top')) {
        secure = true;
      }
    }
  } catch (err) {
    secure = false;
  }

  if (!secure) {
    return res.status(400).json({ error: 'Skill issue buddy' });
  }

  // 4. Handle POST vs PATCH logic
  try {
    let targetUrl = data.discord_webhook_url;

    if (req.method === 'POST') {
      // Append wait=true so Discord returns the JSON containing the message ID
      const urlObj = new URL(targetUrl);
      urlObj.searchParams.set('wait', 'true');
      targetUrl = urlObj.toString();
    } else if (req.method === 'PATCH') {
      // Extract message_id from query params or body
      const messageId = queryMessageId || body.message_id;

      if (!messageId) {
        return res.status(400).json({ error: 'Missing message_id for PATCH request' });
      }

      // Format target URL: .../webhooks/ID/TOKEN/messages/MESSAGE_ID
      const cleanBase = targetUrl.split('?')[0].replace(/\/$/, '');
      targetUrl = `${cleanBase}/messages/${messageId}`;
      
      // Clean up payload so we don't pass 'message_id' to Discord
      delete body.message_id;
    }

    const discordResponse = await fetch(targetUrl, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (discordResponse.ok) {
      const responseData = await discordResponse.json();
      return res.status(200).json({ 
        success: true, 
        message_id: responseData.id,
        data: responseData 
      });
    } else {
      const errText = await discordResponse.text();
      return res.status(discordResponse.status).json({ error: 'Discord API Error', details: errText });
    }

  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach Discord' });
  }
}
