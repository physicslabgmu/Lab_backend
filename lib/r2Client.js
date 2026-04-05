const { S3Client } = require('@aws-sdk/client-s3');

let client;

function getR2Endpoint() {
    if (process.env.R2_ENDPOINT) return process.env.R2_ENDPOINT;
    if (process.env.R2_ACCOUNT_ID) {
        return `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    }
    throw new Error('Set R2_ENDPOINT or R2_ACCOUNT_ID');
}

function getR2Client() {
    if (!client) {
        client = new S3Client({
            region: 'auto',
            endpoint: getR2Endpoint(),
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            },
            forcePathStyle: true,
        });
    }
    return client;
}

function getBucket() {
    const b = process.env.R2_BUCKET;
    if (!b) throw new Error('R2_BUCKET is not set');
    return b;
}

function getPublicBaseUrl() {
    return (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');
}

module.exports = { getR2Client, getBucket, getPublicBaseUrl };