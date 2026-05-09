function createParamMetaCore(deps) {
    const {
        getActiveCtrlChar,
        isEscapedQuote,
        TAG_RE
    } = deps;

    function findTopLevelDefaultAssignmentIndex(source) {
        let parenDepth = 0;
        let braceDepth = 0;
        let bracketDepth = 0;
        let inString = false;
        let stringChar = '';

        for (let index = 0; index < source.length; index++) {
            const char = source[index];
            const prev = source[index - 1] || '';
            const next = source[index + 1] || '';

            if (inString) {
                if (char === stringChar && !isEscapedQuote(source, index, getActiveCtrlChar())) {
                    inString = false;
                }
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                continue;
            }
            if (char === '(') {
                parenDepth++;
                continue;
            }
            if (char === ')') {
                parenDepth = Math.max(0, parenDepth - 1);
                continue;
            }
            if (char === '[') {
                bracketDepth++;
                continue;
            }
            if (char === ']') {
                bracketDepth = Math.max(0, bracketDepth - 1);
                continue;
            }
            if (char === '{') {
                braceDepth++;
                continue;
            }
            if (char === '}') {
                braceDepth = Math.max(0, braceDepth - 1);
                continue;
            }
            if (parenDepth || braceDepth || bracketDepth) continue;
            if (char === '=' && prev !== '=' && prev !== '!' && next !== '=') {
                return index;
            }
        }

        return -1;
    }

    function parseParamMeta(paramStr) {
        const raw = String(paramStr || '').trim();
        const defaultIndex = findTopLevelDefaultAssignmentIndex(raw);
        const hasDefault = defaultIndex >= 0;
        const p = hasDefault ? raw.slice(0, defaultIndex).trim() : raw;
        let expectedTag = '';
        const dimMatches = p.match(/\[[^\]]*\]/g) || [];
        const expectedDims = dimMatches.join('');
        const expectedDimParts = dimMatches.map(dim => dim.slice(1, -1).trim());
        let name = '';
        let source = p;
        const isConst = /^const\b/.test(source);
        if (isConst) source = source.replace(/^const\b\s*/, '');
        const isByRef = /^&\s*/.test(source);
        if (isByRef) source = source.replace(/^&\s*/, '');
        source = source.trim();
        const tagM = source.match(TAG_RE);
        if (tagM) {
            expectedTag = tagM[1];
            source = source.slice(tagM[0].length);
        }
        const nameMatch = source.match(/^([A-Za-z_@]\w*)/);
        if (nameMatch) name = nameMatch[1];
        return {
            raw,
            name,
            expectedTag,
            expectedDims,
            expectedDimParts,
            hasDefault,
            isConst,
            isByRef
        };
    }

    function parseUnionTagOptions(tagSpec) {
        const raw = String(tagSpec || '').trim();
        if (!raw.startsWith('{') || !raw.endsWith('}')) return [];
        return raw.slice(1, -1)
            .split(',')
            .map(part => part.trim())
            .filter(Boolean);
    }

    return {
        findTopLevelDefaultAssignmentIndex,
        parseParamMeta,
        parseUnionTagOptions
    };
}

module.exports = { createParamMetaCore };
