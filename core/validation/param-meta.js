const { findTopLevelSimpleAssignmentOperator } = require('../syntax/top-level');

function createParamMetaCore(deps) {
    const {
        getActiveCtrlChar,
        isEscapedQuote,
        TAG_RE
    } = deps;

    function findTopLevelDefaultAssignmentIndex(source) {
        return findTopLevelSimpleAssignmentOperator(source, {
            isEscapedQuote,
            escapeChar: getActiveCtrlChar()
        });
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
