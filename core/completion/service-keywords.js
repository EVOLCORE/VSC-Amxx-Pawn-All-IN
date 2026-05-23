const { getBestCompletionMatch } = require('./matching');

const SERVICE_KEYWORD_COMPLETIONS = [
    { name: 'if', detail: 'statement', insertText: 'if (${1:condition}) {\n\t$0\n}', context: 'statement' },
    { name: 'else', detail: 'statement', insertText: 'else {\n\t$0\n}', context: 'else' },
    { name: 'for', detail: 'loop statement', insertText: 'for (new ${1:i} = 0; ${1:i} < ${2:count}; ${1:i}++) {\n\t$0\n}', context: 'statement' },
    { name: 'while', detail: 'loop statement', insertText: 'while (${1:condition}) {\n\t$0\n}', context: 'statement' },
    { name: 'do', detail: 'loop statement', insertText: 'do {\n\t$0\n} while (${1:condition});', context: 'statement' },
    { name: 'switch', detail: 'switch statement', insertText: 'switch (${1:value}) {\n\tcase ${2:0}: {\n\t\t$0\n\t}\n}', context: 'statement' },
    { name: 'case', detail: 'switch label', insertText: 'case ${1:value}: {\n\t$0\n}', context: 'switch-label' },
    { name: 'default', detail: 'switch label', insertText: 'default: {\n\t$0\n}', context: 'switch-label' },
    { name: 'break', detail: 'loop/switch control', insertText: 'break;', context: 'break' },
    { name: 'continue', detail: 'loop control', insertText: 'continue;', context: 'loop' },
    { name: 'return', detail: 'statement', insertText: 'return $0;', context: 'statement' },
    { name: 'goto', detail: 'statement', insertText: 'goto ${1:label};', context: 'statement' },
    { name: 'state', detail: 'statement', insertText: 'state ${1:name};', context: 'statement' },
    { name: 'exit', detail: 'statement', insertText: 'exit;', context: 'statement' }
];

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
    createServiceKeywordCandidateSelector
};
