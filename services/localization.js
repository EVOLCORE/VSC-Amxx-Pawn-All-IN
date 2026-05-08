const fs = require('fs');
const path = require('path');

const messagesCache = new Map();

function normalizeLanguageId(languageId) {
    return String(languageId || 'en')
        .trim()
        .replace(/_/g, '-')
        .toLowerCase() || 'en';
}

function getLanguageCandidates(languageId) {
    const normalized = normalizeLanguageId(languageId);
    const candidates = [normalized];
    const dashIndex = normalized.indexOf('-');
    if (dashIndex > 0) {
        candidates.push(normalized.slice(0, dashIndex));
    }
    if (!candidates.includes('en')) {
        candidates.push('en');
    }
    return candidates;
}

function readMessagesFile(languageId) {
    const normalized = normalizeLanguageId(languageId);
    if (messagesCache.has(normalized)) {
        return messagesCache.get(normalized);
    }

    const filePath = path.join(__dirname, '..', 'localization', `${normalized}.json`);
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        messagesCache.set(normalized, parsed && typeof parsed === 'object' ? parsed : {});
    } catch {
        messagesCache.set(normalized, {});
    }

    return messagesCache.get(normalized);
}

function interpolate(template, variables = {}) {
    return String(template || '').replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, key) => {
        if (!Object.prototype.hasOwnProperty.call(variables, key)) {
            return `{${key}}`;
        }
        return String(variables[key]);
    });
}

function createRuntimeLocalization(vscodeModule) {
    const languageId = normalizeLanguageId(vscodeModule?.env?.language || 'en');
    const candidates = getLanguageCandidates(languageId);
    const mergedMessages = {};

    for (let i = candidates.length - 1; i >= 0; i--) {
        Object.assign(mergedMessages, readMessagesFile(candidates[i]));
    }

    const t = (key, variables = null, fallback = null) => {
        const template = Object.prototype.hasOwnProperty.call(mergedMessages, key)
            ? mergedMessages[key]
            : (fallback != null ? fallback : key);
        return variables ? interpolate(template, variables) : String(template);
    };

    return {
        languageId,
        t
    };
}

module.exports = {
    createRuntimeLocalization
};
