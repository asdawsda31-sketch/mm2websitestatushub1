const axios = require('axios');

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const SECRET_KEY = process.env.SECRET_KEY;
const MAX_PAYLOAD_SIZE = 1024 * 1024;
const REQUEST_TIMEOUT = 30000;

const requestLog = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 30;

function base64Decode(data) {
    const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    data = data.replace(/[^A-Za-z0-9+/=]/g, '');
    let result = '';
    for (let i = 0; i < data.length; i += 4) {
        const a = b64.indexOf(data[i]);
        const b = b64.indexOf(data[i+1]);
        const c = b64.indexOf(data[i+2]);
        const d = b64.indexOf(data[i+3]);
        const n = (a << 18) | (b << 12) | (c << 6) | d;
        result += String.fromCharCode((n >> 16) & 255);
        if (data[i+2] !== '=') result += String.fromCharCode((n >> 8) & 255);
        if (data[i+3] !== '=') result += String.fromCharCode(n & 255);
    }
    return result;
}

function xorDecrypt(data, key) {
    let output = '';
    for (let i = 0; i < data.length; i++) {
        output += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return output;
}

function decryptData(encryptedData) {
    const decoded = Buffer.from(encryptedData, 'base64').toString('utf8');
    const xored = xorDecrypt(decoded, SECRET_KEY);
    return Buffer.from(xored, 'base64').toString('utf8');
}

function getClientIp(req) {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW;
    const requests = requestLog.get(ip) || [];
    const recentRequests = requests.filter(t => t > windowStart);
    if (recentRequests.length >= RATE_LIMIT_MAX) {
        return false;
    }
    recentRequests.push(now);
    requestLog.set(ip, recentRequests);
    return true;
}

function cleanupLogs() {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW;
    for (const [ip, requests] of requestLog.entries()) {
        const recent = requests.filter(t => t > windowStart);
        if (recent.length === 0) {
            requestLog.delete(ip);
        } else {
            requestLog.set(ip, recent);
        }
    }
}

function validatePayload(data) {
    if (!data || typeof data !== 'object') {
        return { valid: false, error: 'Invalid payload structure' };
    }
    if (!data.embeds || !Array.isArray(data.embeds) || data.embeds.length === 0) {
        return { valid: false, error: 'Missing embeds array' };
    }
    const embed = data.embeds[0];
    if (!embed || typeof embed !== 'object') {
        return { valid: false, error: 'Invalid embed structure' };
    }
    const fields = embed.fields || [];
    if (!Array.isArray(fields)) {
        return { valid: false, error: 'Invalid fields structure' };
    }
    if (fields.length > 6) {
        return { valid: false, error: 'Too many fields' };
    }
    const footerText = embed.footer && embed.footer.text ? embed.footer.text : '';
    if (!footerText.includes('Status Hub On Top')) {
        return { valid: false, error: 'Invalid footer signature' };
    }
    return { valid: true };
}

async function forwardToDiscord(payload) {
    const response = await axios.post(DISCORD_WEBHOOK, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
        validateStatus: () => true
    });
    return response;
}

function sanitizeString(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

module.exports = async function handler(req, res) {
    const startTime = Date.now();
    const clientIp = getClientIp(req);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
    
    if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    
    cleanupLogs();
    
    try {
        const contentLength = parseInt(req.headers['content-length'] || '0');
        if (contentLength > MAX_PAYLOAD_SIZE) {
            return res.status(413).json({ error: 'Payload too large' });
        }
        
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'Invalid request body' });
        }
        
        const encryptedPayload = req.body.encrypted;
        if (!encryptedPayload || typeof encryptedPayload !== 'string') {
            return res.status(400).json({ error: 'Missing encrypted field' });
        }
        
        let decryptedJson;
        try {
            decryptedJson = decryptData(encryptedPayload);
        } catch (err) {
            return res.status(400).json({ error: 'Decryption failed' });
        }
        
        let parsedData;
        try {
            parsedData = JSON.parse(decryptedJson);
        } catch (err) {
            return res.status(400).json({ error: 'Invalid JSON after decryption' });
        }
        
        const validation = validatePayload(parsedData);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }
        
        const discordResponse = await forwardToDiscord(parsedData);
        const elapsed = Date.now() - startTime;
        
        if (discordResponse.status >= 200 && discordResponse.status < 300) {
            return res.status(200).json({ 
                success: true, 
                discordStatus: discordResponse.status,
                processingTime: elapsed
            });
        } else {
            return res.status(502).json({ 
                error: 'Discord webhook failed',
                discordStatus: discordResponse.status,
                discordBody: discordResponse.data
            });
        }
        
    } catch (err) {
        const elapsed = Date.now() - startTime;
        return res.status(500).json({ 
            error: err.message,
            processingTime: elapsed
        });
    }
};
