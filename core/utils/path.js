const path = require('path');

function createPathUtilityCore() {
    const normalizedPathCache = new Map();
    const MAX_NORMALIZED_PATH_CACHE_SIZE = 4096;
    const normalizeFsPath = filePath => {
        if (!filePath) return '';
        const cacheKey = String(filePath);
        const cached = normalizedPathCache.get(cacheKey);
        if (cached) return cached;
        const normalized = path.normalize(path.resolve(cacheKey)).replace(/[\\/]+/g, '\\').toLowerCase();
        if (normalizedPathCache.size >= MAX_NORMALIZED_PATH_CACHE_SIZE) {
            const oldestKey = normalizedPathCache.keys().next().value;
            if (oldestKey !== undefined) {
                normalizedPathCache.delete(oldestKey);
            }
        }
        normalizedPathCache.set(cacheKey, normalized);
        return normalized;
    };

    const isSameFilePath = (left, right) =>
        !!left && !!right && normalizeFsPath(left) === normalizeFsPath(right);

    return {
        normalizeFsPath,
        isSameFilePath
    };
}

module.exports = { createPathUtilityCore };
