const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fetch = require('node-fetch');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { webhook_url, discord_user_id, country, ip } = req.body;

    if (!webhook_url) {
        return res.status(400).json({ error: 'Missing webhook_url' });
    }

    try {
        const testResponse = await fetch(webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: "🔹 RAYZ HUB Webhook Protection Active" })
        });

        if (!testResponse.ok) return res.status(400).json({ error: 'Invalid Webhook URL' });

        const token = crypto.randomBytes(32).toString('hex');

        const { error } = await supabase
            .from('webhooks')
            .insert([{ 
                proxy_token: token, 
                discord_webhook_url: webhook_url,
                discord_user_id: discord_user_id || 'Unknown',
                country: country || 'Unknown',
                ip: ip || '0.0.0.0'
            }]);

        if (error) {
            console.error("Supabase Error:", error);
            return res.status(500).json({ error: 'Database saving failed', details: error.message });
        }

        return res.status(200).json({ success: true, token: token });
    } catch (err) {
        console.error("Registration Exception:", err);
        return res.status(500).json({ error: 'Server Error', details: err.message });
    }
}
