const express = require('express');
const multer = require('multer');
const { randomUUID, createHash } = require('crypto');
const path = require('path');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const adminBasicAuth = require('../middleware/adminBasicAuth');
const { getR2Client, getBucket, getPublicBaseUrl } = require('../lib/r2Client');

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
});

const MAX_FILES_PER_REQUEST = 20;

function isPdfFile(f) {
    const name = (f.originalname || '').toLowerCase();
    return f.mimetype === 'application/pdf' || name.endsWith('.pdf');
}

function activityKeyFrom(course, activityName) {
    const n = (activityName || '').trim();
    return createHash('sha256').update(`${course}\0${n}`).digest('hex').slice(0, 32);
}

const SLOTS_KEY = 'config/asset-slots.json';

async function readSlotsJson() {
    try {
        const res = await getR2Client().send(
            new GetObjectCommand({ Bucket: getBucket(), Key: SLOTS_KEY })
        );
        const body = await res.Body.transformToString('utf-8');
        return JSON.parse(body);
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return {};
        }
        throw err;
    }
}

async function writeSlotsJson(obj) {
    await getR2Client().send(
        new PutObjectCommand({
            Bucket: getBucket(),
            Key: SLOTS_KEY,
            Body: JSON.stringify(obj, null, 2),
            ContentType: 'application/json',
        })
    );
}

router.get('/admin/ping', adminBasicAuth, (req, res) => {
    res.json({ ok: true });
});

async function uploadBuffersToRecords(bufFiles, base) {
    const records = [];
    for (let i = 0; i < bufFiles.length; i++) {
        const f = bufFiles[i];
        if (!f.buffer) continue;
        const safeName = path.basename(f.originalname || 'upload').replace(/[^\w.\-]/g, '_') || 'file';
        const fileName =
            path.basename((f.originalname || '').trim() || safeName) || 'file';
        const key = `uploads/${randomUUID()}-${safeName}`;

        await getR2Client().send(
            new PutObjectCommand({
                Bucket: getBucket(),
                Key: key,
                Body: f.buffer,
                ContentType: f.mimetype || 'application/octet-stream',
            })
        );

        const url = base ? `${base}/${key}` : undefined;
        records.push({
            url: url || key,
            key,
            fileName,
            addedAt: new Date().toISOString(),
        });
    }
    return records;
}

router.post(
    '/upload',
    adminBasicAuth,
    upload.fields([
        { name: 'file', maxCount: MAX_FILES_PER_REQUEST },
        { name: 'manual', maxCount: MAX_FILES_PER_REQUEST },
    ]),
    async (req, res, next) => {
        try {
            const grouped = req.files || {};
            const imageFiles = grouped.file || [];
            const manualFiles = grouped.manual || [];

            if (!imageFiles.length && !manualFiles.length) {
                return res.status(400).json({
                    error: 'Provide at least one picture file and/or one lab manual (PDF)',
                });
            }

            for (let i = 0; i < manualFiles.length; i++) {
                if (!isPdfFile(manualFiles[i])) {
                    return res.status(400).json({
                        error:
                            'Lab manuals must be PDF files: ' +
                            (manualFiles[i].originalname || 'unknown'),
                    });
                }
            }

            const base = getPublicBaseUrl();
            const newFileRecords = await uploadBuffersToRecords(imageFiles, base);
            const newManualRecords = await uploadBuffersToRecords(manualFiles, base);

            const payload = {
                filesUploaded: newFileRecords.length,
                manualsUploaded: newManualRecords.length,
                keys: newFileRecords.map((r) => r.key),
                manualKeys: newManualRecords.map((r) => r.key),
                fileNames: newFileRecords.map((r) => r.fileName),
                manualFileNames: newManualRecords.map((r) => r.fileName),
            };
            if (newFileRecords[0]) {
                if (newFileRecords[0].url) payload.url = newFileRecords[0].url;
                payload.key = newFileRecords[0].key;
            }
            if (newManualRecords[0] && !payload.url) {
                if (newManualRecords[0].url) payload.url = newManualRecords[0].url;
                payload.key = newManualRecords[0].key;
            }

            const slotId = (req.body.slotId || '').trim();
            if (slotId) {
                const slots = await readSlotsJson();

                if (slotId.endsWith(':new_row')) {
                    const courseSlug = slotId.split(':')[0];
                    const arrayKey = slotId.replace(/:new_row$/, ':new_rows');
                    const activityName = (req.body.name || '').trim();
                    const ak = activityKeyFrom(courseSlug, activityName);

                    if (!Array.isArray(slots[arrayKey])) slots[arrayKey] = [];
                    const list = slots[arrayKey];

                    let idx = list.findIndex(
                        (e) =>
                            (e.activityKey && e.activityKey === ak) ||
                            (!e.activityKey && (e.name || '').trim() === activityName)
                    );

                    const desc = (req.body.description || '').trim() || undefined;

                    if (idx >= 0) {
                        const e = list[idx];
                        if (!e.activityKey) e.activityKey = ak;
                        const existingFiles =
                            Array.isArray(e.files) && e.files.length
                                ? e.files.slice()
                                : e.url
                                  ? [
                                        {
                                            url: e.url,
                                            key: e.key,
                                            fileName: e.fileName,
                                            addedAt: e.addedAt,
                                        },
                                    ]
                                  : [];
                        const existingManuals = Array.isArray(e.manuals) && e.manuals.length
                            ? e.manuals.slice()
                            : [];
                        e.files = existingFiles.concat(newFileRecords);
                        e.manuals = existingManuals.concat(newManualRecords);
                        e.name = activityName || e.name;
                        if (desc) e.description = desc;
                        e.updatedAt = new Date().toISOString();
                        delete e.url;
                        delete e.key;
                        delete e.fileName;
                        delete e.alt;
                        payload.activityKey = ak;
                        payload.merged = true;
                        payload.totalFilesInRow = e.files.length;
                        payload.totalManualsInRow = e.manuals.length;
                    } else {
                        list.push({
                            activityKey: ak,
                            name: activityName || undefined,
                            description: desc,
                            addedAt: new Date().toISOString(),
                            files: newFileRecords,
                            manuals: newManualRecords,
                        });
                        payload.activityKey = ak;
                        payload.merged = false;
                        payload.totalFilesInRow = newFileRecords.length;
                        payload.totalManualsInRow = newManualRecords.length;
                    }
                } else {
                    const r0 = newFileRecords[0] || newManualRecords[0];
                    if (!r0) {
                        return res.status(400).json({ error: 'No files processed for this slot' });
                    }
                    slots[slotId] = {
                        url: r0.url,
                        key: r0.key,
                        fileName: r0.fileName,
                        name: (req.body.name || '').trim() || undefined,
                        description: (req.body.description || '').trim() || undefined,
                        alt: (req.body.alt || req.body.name || '').trim() || undefined,
                        updatedAt: new Date().toISOString(),
                    };
                    if (newFileRecords.length > 1) {
                        slots[slotId].files = newFileRecords;
                    }
                    if (newManualRecords.length) {
                        slots[slotId].manuals = newManualRecords;
                    }
                }

                await writeSlotsJson(slots);
                payload.slotId = slotId;
            }

            res.status(201).json(payload);
        } catch (err) {
            next(err);
        }
    }
);

router.get('/public/asset-slots', async (_req, res, next) => {
    try {
        const slots = await readSlotsJson();
        res.set('Cache-Control', 'public, max-age=60');
        res.json(slots);
    } catch (err) {
        next(err);
    }
});

module.exports = router;