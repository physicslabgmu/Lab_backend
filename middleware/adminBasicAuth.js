const crypto = require('crypto');

function safeEqualString(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function adminBasicAuth(req, res, next) {
    const expectedUser = process.env.ADMIN_USERNAME;
    const expectedPass = process.env.ADMIN_PASSWORD;
    if (!expectedUser || !expectedPass) {
        console.error('ADMIN_USERNAME / ADMIN_PASSWORD not set');
        return res.status(500).json({ error: 'Server auth not configured' });
    }

    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    let decoded;
    try {
        decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const colon = decoded.indexOf(':');
    const user = colon === -1 ? decoded : decoded.slice(0, colon);
    const pass = colon === -1 ? '' : decoded.slice(colon + 1);

    if (safeEqualString(user, expectedUser) && safeEqualString(pass, expectedPass)) {
        return next();
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = adminBasicAuth;