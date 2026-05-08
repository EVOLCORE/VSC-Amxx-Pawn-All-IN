const crypto = require('crypto');

const stringHashCache = new Map();
const defineDeclsSignatureCache = new WeakMap();
const defineDeclSignatureChunkCache = new WeakMap();
const STRING_HASH_CACHE_LIMIT = 4096;
const STRING_HASH_CACHE_MAX_KEY_CHARS = 65536;
const STRING_HASH_CACHE_MAX_TOTAL_KEY_CHARS = 2 * 1024 * 1024;
let stringHashCacheKeyChars = 0;
const EMPTY_SHA1 = crypto.createHash('sha1').update('').digest('hex');

function isCanonicalDefineDeclsSignature(value, expectedCount) {
    const text = String(value || '');
    const colonIndex = text.indexOf(':');
    if (colonIndex <= 0 || text.length !== colonIndex + 1 + 40) return false;
    if (Number.parseInt(text.slice(0, colonIndex), 10) !== expectedCount) return false;
    for (let index = colonIndex + 1; index < text.length; index++) {
        const code = text.charCodeAt(index);
        const isHex =
            (code >= 48 && code <= 57) ||
            (code >= 97 && code <= 102);
        if (!isHex) return false;
    }
    return true;
}

function touchStringHashCache(key, value) {
    const cached = stringHashCache.get(key);
    if (cached) {
        stringHashCacheKeyChars -= cached.length || 0;
    }
    stringHashCache.delete(key);
    const entry = { value, length: key.length };
    stringHashCache.set(key, entry);
    stringHashCacheKeyChars += entry.length;
    while (
        stringHashCache.size > STRING_HASH_CACHE_LIMIT ||
        stringHashCacheKeyChars > STRING_HASH_CACHE_MAX_TOTAL_KEY_CHARS
    ) {
        const oldestKey = stringHashCache.keys().next().value;
        const oldest = stringHashCache.get(oldestKey);
        stringHashCache.delete(oldestKey);
        stringHashCacheKeyChars -= oldest?.length || 0;
    }
}

function getSha1Hex(text) {
    return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}

function getCachedStringHash(value = '', options = {}) {
    const text = String(value || '');
    if (!text) return '';
    const prefix = options.prefix === undefined ? 'h:' : String(options.prefix || '');
    if (text.length <= STRING_HASH_CACHE_MAX_KEY_CHARS) {
        const cached = stringHashCache.get(text);
        if (cached) {
            touchStringHashCache(text, cached.value);
            return `${prefix}${cached.value}`;
        }
    }
    const hashed = getSha1Hex(text);
    if (text.length <= STRING_HASH_CACHE_MAX_KEY_CHARS) {
        touchStringHashCache(text, hashed);
    }
    return `${prefix}${hashed}`;
}

function getLengthPrefixedText(value) {
    const text = String(value ?? '');
    return `${text.length}:${text}\0`;
}

function updateLengthPrefixed(hash, value) {
    hash.update(getLengthPrefixedText(value));
}

function getDefineDeclSignatureChunk(decl) {
    if (decl && (typeof decl === 'object' || typeof decl === 'function')) {
        const cached = defineDeclSignatureChunkCache.get(decl);
        if (cached) return cached;
        const chunk = getLengthPrefixedText(decl?.name || '') +
            getLengthPrefixedText(decl?.args || '') +
            getLengthPrefixedText(decl?.macroStyle || '') +
            getLengthPrefixedText(decl?.macroIndexer || '') +
            getLengthPrefixedText(decl?.value || '');
        defineDeclSignatureChunkCache.set(decl, chunk);
        return chunk;
    }
    return getLengthPrefixedText(decl?.name || '') +
        getLengthPrefixedText(decl?.args || '') +
        getLengthPrefixedText(decl?.macroStyle || '') +
        getLengthPrefixedText(decl?.macroIndexer || '') +
        getLengthPrefixedText(decl?.value || '');
}

function getDefineDeclsSignature(defineDecls = [], fallbackDefineStateKey = '', options = {}) {
    if (Array.isArray(defineDecls) && defineDecls.length) {
        if (isCanonicalDefineDeclsSignature(fallbackDefineStateKey, defineDecls.length)) {
            return String(fallbackDefineStateKey);
        }
        const cached = defineDeclsSignatureCache.get(defineDecls);
        if (cached) return cached;
        const hash = crypto.createHash('sha1');
        for (const decl of defineDecls) {
            hash.update(getDefineDeclSignatureChunk(decl));
        }
        const signature = `${defineDecls.length}:${hash.digest('hex')}`;
        defineDeclsSignatureCache.set(defineDecls, signature);
        return signature;
    }
    return getCachedStringHash(fallbackDefineStateKey, {
        prefix: options.fallbackPrefix === undefined ? 'h:' : options.fallbackPrefix
    });
}

function getDefineStateSignature(defineDecls = [], defineStateKey = '', options = {}) {
    const stateKey = String(defineStateKey || '');
    return stateKey || getDefineDeclsSignature(defineDecls, '', options);
}

function getIncludeEntriesSignatureHash(includeEntries = [], normalizeFsPath, getEntryDefineSignature, options = {}) {
    const hash = crypto.createHash('sha1');
    let count = 0;
    const normalize = typeof normalizeFsPath === 'function'
        ? normalizeFsPath
        : value => String(value || '');
    const getDefineSignature = typeof getEntryDefineSignature === 'function'
        ? getEntryDefineSignature
        : entry => getDefineStateSignature(entry?.defineDecls || [], entry?.defineStateKey || '');

    for (const entry of includeEntries || []) {
        hash.update(
            `${normalize(entry?.filePath || '')}\0` +
            `${getDefineSignature(entry)}\0` +
            `${Number.isInteger(entry?.depth) ? entry.depth : 0}\0`
        );
        count++;
    }

    if (count === 0 && options.emptySignature === '') return '';
    return `${count}:${count > 0 ? hash.digest('hex') : EMPTY_SHA1}`;
}

function compareSignatureTuples(left = [], right = []) {
    const maxLength = Math.max(left.length || 0, right.length || 0);
    for (let index = 0; index < maxLength; index++) {
        const leftText = String(left[index] ?? '');
        const rightText = String(right[index] ?? '');
        if (leftText < rightText) return -1;
        if (leftText > rightText) return 1;
    }
    return 0;
}

function getSortedTuplesSignatureHash(tuples = [], options = {}) {
    const sourceTuples = Array.isArray(tuples) ? tuples : [];
    const sortedTuples = sourceTuples
        .map(tuple => Array.isArray(tuple) ? tuple : [tuple])
        .sort(compareSignatureTuples);
    const hash = crypto.createHash('sha1');
    for (const tuple of sortedTuples) {
        hash.update(String(tuple.length));
        hash.update(':');
        for (const part of tuple) {
            updateLengthPrefixed(hash, part);
        }
    }
    const count = Number.isInteger(options.count) ? options.count : sortedTuples.length;
    return `${count}:${hash.digest('hex')}`;
}

module.exports = {
    getSha1Hex,
    getCachedStringHash,
    getDefineDeclsSignature,
    getDefineStateSignature,
    getIncludeEntriesSignatureHash,
    getSortedTuplesSignatureHash
};
