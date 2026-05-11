const crypto = require('crypto');
const {
    isPawnIdentifierStartChar,
    isPawnIdentifierContinueChar,
    isPawnIdentifierBoundaryChar
} = require('../syntax/identifiers');

// Small shared utilities that do not belong to a single feature/domain.
function createUtilityCore() {
    function escapeRegExp(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function normalizeExtensionList(values, fallback = [], options = {}) {
        const useFallbackWhenEmpty = options?.useFallbackWhenEmpty === true;
        const source = Array.isArray(values) && (!useFallbackWhenEmpty || values.length)
            ? values
            : fallback;
        const result = [];
        for (const value of source || []) {
            let ext = String(value || '').trim().toLowerCase();
            if (!ext) continue;
            if (!ext.startsWith('.')) ext = `.${ext}`;
            if (!result.includes(ext)) result.push(ext);
        }
        return result;
    }

    function normalizeLiveValidationIssueMode(value) {
        return String(value || 'errors-and-warnings').trim().toLowerCase() === 'errors-only'
            ? 'errors-only'
            : 'errors-and-warnings';
    }

    function areLiveValidationWarningsEnabled(issueMode) {
        return normalizeLiveValidationIssueMode(issueMode) !== 'errors-only';
    }

    function getDocumentFingerprint(document, cache = null) {
        if (!document) return '';
        if (cache && typeof document === 'object') {
            const cached = cache.get(document);
            if (cached && cached.version === document.version) {
                return cached.fingerprint;
            }
        }
        let text = '';
        try {
            if (typeof document.getText === 'function') {
                text = String(document.getText() || '');
            } else if (Number.isInteger(document.lineCount) && typeof document.lineAt === 'function') {
                const lines = [];
                for (let line = 0; line < document.lineCount; line++) {
                    lines.push(String(document.lineAt(line)?.text || ''));
                }
                text = lines.join('\n');
            } else {
                return `v:${document.version ?? ''}|l:${document.lineCount ?? ''}`;
            }
        } catch {
            return `v:${document.version ?? ''}|l:${document.lineCount ?? ''}`;
        }
        const fingerprint = `${text.length}:${crypto.createHash('sha1').update(text).digest('hex')}`;
        if (cache && typeof document === 'object') {
            cache.set(document, {
                version: document.version,
                fingerprint
            });
        }
        return fingerprint;
    }

    return {
        escapeRegExp,
        normalizeExtensionList,
        normalizeLiveValidationIssueMode,
        areLiveValidationWarningsEnabled,
        getDocumentFingerprint,
        isPawnIdentifierStartChar,
        isPawnIdentifierContinueChar,
        isPawnIdentifierBoundaryChar
    };
}

module.exports = { createUtilityCore };
