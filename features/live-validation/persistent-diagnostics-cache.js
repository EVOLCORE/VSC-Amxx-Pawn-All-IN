const crypto = require('crypto');

function createPersistentLiveDiagnosticsCache(deps) {
    const {
        vscode,
        fs,
        path,
        normalizeFsPath,
        persistentCacheRoot = '',
        getPersistentCacheMaxBytes = () => 0,
        prunePersistentCache = null
    } = deps;

    const CACHE_SCHEMA = 'live-diagnostics';
    const CACHE_DIR_NAME = 'amxx-pawn-all-in-cache';

    function getMaxBytes() {
        const rawValue = Number(
            typeof getPersistentCacheMaxBytes === 'function'
                ? getPersistentCacheMaxBytes()
                : getPersistentCacheMaxBytes
        );
        if (!Number.isFinite(rawValue) || rawValue <= 0) return 0;
        return Math.floor(rawValue);
    }

    function isEnabled() {
        return getMaxBytes() > 0;
    }

    function hashPart(value = '') {
        return crypto.createHash('sha1').update(String(value || '')).digest('hex');
    }

    function getCacheDir() {
        if (!isEnabled()) return '';
        const root = String(persistentCacheRoot || '').trim();
        return root ? path.join(root, CACHE_DIR_NAME) : '';
    }

    function getCacheFilePath(filePath, documentFingerprint, settingsSignature) {
        const cacheDir = getCacheDir();
        if (!cacheDir) return '';
        const key = [
            CACHE_SCHEMA,
            normalizeFsPath(filePath),
            String(documentFingerprint || ''),
            String(settingsSignature || '')
        ].join('\n');
        return path.join(cacheDir, `${hashPart(key)}.json`);
    }

    function serializeDiagnostic(diagnostic) {
        const range = diagnostic?.range || {};
        const values = [
            range.start?.line ?? 0,
            range.start?.character ?? 0,
            range.end?.line ?? range.start?.line ?? 0,
            range.end?.character ?? range.start?.character ?? 1,
            String(diagnostic?.message || ''),
            diagnostic?.severity === vscode?.DiagnosticSeverity?.Error || diagnostic?.severity == null
                ? null
                : diagnostic.severity,
            diagnostic?.source && diagnostic.source !== 'AMXX Pawn All-In' ? diagnostic.source : null,
            diagnostic?.code ?? null,
            Array.isArray(diagnostic?.tags) && diagnostic.tags.length ? [...diagnostic.tags] : null
        ];
        while (values.length > 5 && (values[values.length - 1] === null || values[values.length - 1] === '')) {
            values.pop();
        }
        return values;
    }

    function deserializeDiagnostic(serialized) {
        if (!Array.isArray(serialized) || serialized.length < 5) return null;
        const [
            startLine,
            startChar,
            endLine,
            endChar,
            message,
            severity,
            source,
            code,
            tags
        ] = serialized;
        const range = new vscode.Range(
            new vscode.Position(startLine ?? 0, startChar ?? 0),
            new vscode.Position(endLine ?? startLine ?? 0, endChar ?? startChar ?? 1)
        );
        const diagnostic = new vscode.Diagnostic(
            range,
            String(message || ''),
            severity ?? vscode?.DiagnosticSeverity?.Error ?? 0
        );
        diagnostic.source = source || 'AMXX Pawn All-In';
        if (code !== null && code !== undefined) diagnostic.code = code;
        if (Array.isArray(tags) && tags.length) diagnostic.tags = tags;
        return diagnostic;
    }

    function read(document, options = {}) {
        if (!isEnabled() || document?.isDirty === true) return null;
        const documentFingerprint = String(options.documentFingerprint || '');
        const settingsSignature = String(options.settingsSignature || '');
        if (!document?.fileName || !documentFingerprint || !settingsSignature) return null;

        const cacheFilePath = getCacheFilePath(document.fileName, documentFingerprint, settingsSignature);
        if (!cacheFilePath || !fs.existsSync(cacheFilePath)) return null;

        try {
            const payload = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
            if (payload?.s !== CACHE_SCHEMA) return null;
            if (String(payload?.p || '') !== hashPart(normalizeFsPath(document.fileName))) return null;
            if (String(payload?.f || '') !== hashPart(documentFingerprint)) return null;
            if (String(payload?.g || '') !== hashPart(settingsSignature)) return null;
            const diagnostics = (Array.isArray(payload?.d) ? payload.d : [])
                .map(deserializeDiagnostic)
                .filter(Boolean);
            return {
                diagnostics,
                documentFingerprint,
                dependencySignature: String(payload?.y || '')
            };
        } catch {
            return null;
        }
    }

    function write(document, cacheEntry, options = {}) {
        if (!isEnabled() || document?.isDirty === true) return;
        const documentFingerprint = String(cacheEntry?.documentFingerprint || '');
        const settingsSignature = String(options.settingsSignature || '');
        if (!document?.fileName || !documentFingerprint || !settingsSignature) return;
        if (!Array.isArray(cacheEntry?.diagnostics)) return;

        const cacheFilePath = getCacheFilePath(document.fileName, documentFingerprint, settingsSignature);
        if (!cacheFilePath) return;
        const payload = {
            s: CACHE_SCHEMA,
            p: hashPart(normalizeFsPath(document.fileName)),
            f: hashPart(documentFingerprint),
            g: hashPart(settingsSignature),
            y: String(cacheEntry?.dependencySignature || '')
        };
        if (cacheEntry.diagnostics.length) {
            payload.d = cacheEntry.diagnostics.map(serializeDiagnostic);
        }

        setTimeout(() => {
            if (!isEnabled()) return;
            if (document?.isDirty === true) return;
            const currentCacheDir = getCacheDir();
            if (!currentCacheDir || path.resolve(path.dirname(cacheFilePath)) !== path.resolve(currentCacheDir)) {
                return;
            }
            let payloadText = '';
            try {
                payloadText = JSON.stringify(payload);
            } catch {
                return;
            }
            const maxBytes = getMaxBytes();
            if (maxBytes <= 0 || Buffer.byteLength(payloadText, 'utf8') > Math.max(512 * 1024, Math.floor(maxBytes / 4))) {
                return;
            }
            fs.promises.mkdir(path.dirname(cacheFilePath), { recursive: true })
                .then(() => fs.promises.writeFile(cacheFilePath, payloadText, 'utf8'))
                .then(() => {
                    if (typeof prunePersistentCache === 'function') {
                        prunePersistentCache({ force: true });
                    }
                })
                .catch(() => {});
        }, 0);
    }

    return {
        readPersistentLiveDiagnosticsCache: read,
        writePersistentLiveDiagnosticsCache: write
    };
}

module.exports = { createPersistentLiveDiagnosticsCache };
