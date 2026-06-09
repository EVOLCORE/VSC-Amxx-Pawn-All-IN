const { getBestCompletionMatch } = require('./matching');
const {
    buildBlockSnippet,
    buildDoWhileSnippet,
    buildSwitchSnippet
} = require('./block-snippets');

const SERVICE_KEYWORD_COMPLETIONS = [
    { name: 'new', detail: 'declaration', insertText: 'new', context: 'declaration', preferOverSymbolFallback: true },
    { name: 'static', detail: 'declaration', insertText: 'static', context: 'declaration', preferOverSymbolFallback: true },
    { name: 'const', detail: 'declaration', insertText: 'const', context: 'declaration', preferOverSymbolFallback: true },
    { name: 'enum', detail: 'declaration', blockHeader: 'enum', context: 'declaration', preferOverSymbolFallback: true },
    { name: 'if', detail: 'statement', blockHeader: 'if (${1:condition})', context: 'statement' },
    { name: 'else', detail: 'statement', blockHeader: 'else', context: 'else' },
    { name: 'for', detail: 'loop statement', blockHeader: 'for (new ${1:i} = 0; ${1:i} < ${2:count}; ${1:i}++)', context: 'statement' },
    { name: 'while', detail: 'loop statement', blockHeader: 'while (${1:condition})', context: 'statement' },
    { name: 'do', detail: 'loop statement', snippetKind: 'do-while', context: 'statement' },
    { name: 'switch', detail: 'switch statement', snippetKind: 'switch', context: 'statement' },
    { name: 'case', detail: 'switch label', blockHeader: 'case ${1:value}:', context: 'switch-label' },
    { name: 'default', detail: 'switch label', blockHeader: 'default:', context: 'switch-label' },
    { name: 'break', detail: 'loop/switch control', insertText: 'break;', context: 'break', trailingSemicolon: true },
    { name: 'continue', detail: 'loop control', insertText: 'continue;', context: 'loop', trailingSemicolon: true },
    { name: 'return', detail: 'statement', insertText: 'return $0;', context: 'statement', trailingSemicolon: true },
    { name: 'goto', detail: 'statement', insertText: 'goto ${1:label};', context: 'statement', trailingSemicolon: true },
    { name: 'state', detail: 'statement', insertText: 'state ${1:name};', context: 'statement', trailingSemicolon: true },
    { name: 'exit', detail: 'statement', insertText: 'exit;', context: 'statement', trailingSemicolon: true }
];

function getServiceKeywordInsertText(definition, options = {}) {
    if (!definition) return '';
    if (definition.snippetKind === 'do-while') {
        return buildDoWhileSnippet('${1:condition}', { braceStyle: options.braceStyle });
    }
    if (definition.snippetKind === 'switch') {
        return buildSwitchSnippet({ braceStyle: options.braceStyle });
    }
    if (definition.blockHeader) {
        return buildBlockSnippet(definition.blockHeader, { braceStyle: options.braceStyle });
    }
    const insertText = definition.insertText || definition.name || '';
    if (definition.trailingSemicolon && options.insertSemicolon === false) {
        return insertText.replace(/;$/, '');
    }
    return insertText;
}

function createServiceKeywordCandidateSelector() {
    const cache = new Map();
    const allCandidates = [];
    for (let index = 0; index < SERVICE_KEYWORD_COMPLETIONS.length; index++) {
        allCandidates.push({ definition: SERVICE_KEYWORD_COMPLETIONS[index], index });
    }

    return function getServiceKeywordCandidatesForPrefix(prefix, hasExistingStartsWith = false) {
        const normalizedPrefix = String(prefix || '').toLowerCase();
        const cacheKey = `${hasExistingStartsWith ? 1 : 0}:${normalizedPrefix}`;
        const cached = cache.get(cacheKey);
        if (cached) return cached;

        if (!normalizedPrefix) {
            cache.set(cacheKey, allCandidates);
            return allCandidates;
        }

        const startsWithMatches = [];
        const fallbackMatches = [];
        let startsWithCount = 0;
        let containsCount = 0;
        for (let index = 0; index < SERVICE_KEYWORD_COMPLETIONS.length; index++) {
            const definition = SERVICE_KEYWORD_COMPLETIONS[index];
            const match = getBestCompletionMatch(definition.name, normalizedPrefix, { normalized: true });
            if (!match) continue;
            if (match.kind === 'exact' || match.kind === 'startsWith') {
                startsWithCount++;
                startsWithMatches.push({ definition, index, match });
            } else if (match.kind === 'contains') {
                containsCount++;
                fallbackMatches.push({ definition, index, match });
            } else if (match.kind === 'fuzzy') {
                fallbackMatches.push({ definition, index, match });
            }
        }

        let result = startsWithMatches;
        if (!hasExistingStartsWith && !startsWithCount) {
            result = [];
            for (let index = 0; index < fallbackMatches.length; index++) {
                const candidate = fallbackMatches[index];
                if (
                    candidate.match.kind === 'contains' ||
                    (containsCount === 0 && candidate.match.kind === 'fuzzy')
                ) {
                    result.push(candidate);
                }
            }
        }
        cache.set(cacheKey, result);
        return result;
    };
}

module.exports = {
    SERVICE_KEYWORD_COMPLETIONS,
    getServiceKeywordInsertText,
    createServiceKeywordCandidateSelector
};
