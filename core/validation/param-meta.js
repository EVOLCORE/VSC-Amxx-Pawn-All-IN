const { findTopLevelSimpleAssignmentOperator } = require('../syntax/top-level');
const { readPawnIdentifierAt } = require('../syntax/identifiers');

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
        const dimMatches = p.indexOf('[') >= 0
            ? (p.match(/\[[^\]]*\]/g) || [])
            : [];
        const expectedDims = dimMatches.join('');
        const expectedDimParts = dimMatches.map(dim => dim.slice(1, -1).trim());
        let name = '';
        let source = p;
        const isConst = /^const\b/.test(source);
        if (isConst) source = source.slice(5).trimStart();
        const isByRef = source.charCodeAt(0) === 38; // &
        if (isByRef) source = source.slice(1).trimStart();
        source = source.trim();
        const tagM = source.match(TAG_RE);
        if (tagM) {
            expectedTag = tagM[1];
            source = source.slice(tagM[0].length);
        }
        const nameIdentifier = readPawnIdentifierAt(source, 0);
        if (nameIdentifier) name = nameIdentifier.name;
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

    function isValidPawnParamDescriptor(paramStr) {
        const raw = String(paramStr || '').trim();
        if (!raw) return false;
        const defaultIndex = findTopLevelDefaultAssignmentIndex(raw);
        if (defaultIndex >= 0) return false;
        let source = raw;
        if (/^const\b/.test(source)) source = source.slice(5).trimStart();
        if (source.charCodeAt(0) === 38) source = source.slice(1).trimStart();
        const tagM = source.match(TAG_RE);
        if (tagM) {
            source = source.slice(tagM[0].length);
        }
        const nameIdentifier = readPawnIdentifierAt(source, 0);
        if (!nameIdentifier?.name) return false;
        source = source.slice(nameIdentifier.end).trimStart();
        while (source) {
            if (source.charCodeAt(0) !== 91) return false; // [
            const closeIndex = source.indexOf(']');
            if (closeIndex <= 0) return false;
            const dimBody = source.slice(1, closeIndex);
            if (/[,\[\]]/.test(dimBody)) return false;
            source = source.slice(closeIndex + 1).trimStart();
        }
        return true;
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
        isValidPawnParamDescriptor,
        parseUnionTagOptions
    };
}

module.exports = { createParamMetaCore };
