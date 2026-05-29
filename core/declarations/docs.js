const { parsePragmaDirectiveLine } = require('../syntax/pragma-directives');

const mayHaveDocsCacheByLines = new WeakMap();

function createMayHaveDocsState(rawLines) {
    return {
        flags: new Uint8Array(rawLines.length),
        computedThrough: -1,
        previousAttachableDoc: false,
        blankGap: 0
    };
}

function isDocScanWhitespaceCode(code) {
    return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12;
}

function getFirstNonWhitespaceIndex(line) {
    const source = typeof line === 'string' ? line : String(line || '');
    for (let index = 0; index < source.length; index++) {
        if (!isDocScanWhitespaceCode(source.charCodeAt(index))) return index;
    }
    return -1;
}

function lineHasCommentMarker(line) {
    const source = typeof line === 'string' ? line : String(line || '');
    if (!source) return false;
    return source.indexOf('//') >= 0 || source.indexOf('/*') >= 0 || source.indexOf('*/') >= 0;
}

function lineStartsAttachableDoc(line, firstNonWhitespaceIndex) {
    if (firstNonWhitespaceIndex < 0) return false;
    const source = typeof line === 'string' ? line : String(line || '');
    const char = source[firstNonWhitespaceIndex];
    if (char === '*') return true;
    if (char !== '/') return false;
    const next = source[firstNonWhitespaceIndex + 1] || '';
    return next === '/' || next === '*';
}

function scanMayHaveDocsFlags(rawLines, state, targetLine) {
    for (let lineNumber = state.computedThrough + 1; lineNumber <= targetLine; lineNumber++) {
        const line = rawLines[lineNumber] || '';
        const firstNonWhitespaceIndex = getFirstNonWhitespaceIndex(line);
        const ownLineHasComment = lineHasCommentMarker(line);
        state.flags[lineNumber] = (ownLineHasComment || state.previousAttachableDoc) ? 2 : 1;

        if (firstNonWhitespaceIndex < 0) {
            if (state.previousAttachableDoc) {
                state.blankGap++;
                if (state.blankGap > 1) {
                    state.previousAttachableDoc = false;
                }
            }
            state.computedThrough = lineNumber;
            continue;
        }

        if (lineStartsAttachableDoc(line, firstNonWhitespaceIndex)) {
            state.previousAttachableDoc = true;
            state.blankGap = 0;
        } else {
            state.previousAttachableDoc = false;
            state.blankGap = 0;
        }
        state.computedThrough = lineNumber;
    }
}

function buildMayHaveDocsFlags(rawLines) {
    const state = createMayHaveDocsState(rawLines);
    scanMayHaveDocsFlags(rawLines, state, rawLines.length - 1);
    return state.flags;
}

function mayHaveDocsForLine(rawLines, lineNumber) {
    if (!Array.isArray(rawLines) || lineNumber < 0 || lineNumber >= rawLines.length) return false;
    let cachedState = mayHaveDocsCacheByLines.get(rawLines);
    if (!cachedState || cachedState.flags?.length !== rawLines.length) {
        cachedState = createMayHaveDocsState(rawLines);
        mayHaveDocsCacheByLines.set(rawLines, cachedState);
    }
    if (cachedState.computedThrough < lineNumber) {
        scanMayHaveDocsFlags(rawLines, cachedState, lineNumber);
    }
    return cachedState.flags[lineNumber] === 2;
}

function attachLazyDocs(target, propName, resolveDocs, mayHaveDocs = true) {
    if (!mayHaveDocs) {
        return target;
    }
    let resolved = false;
    let value = '';
    Object.defineProperty(target, propName, {
        enumerable: true,
        configurable: true,
        get() {
            if (!resolved) {
                value = String(typeof resolveDocs === 'function' ? (resolveDocs() || '') : '');
                resolved = true;
            }
            Object.defineProperty(target, propName, {
                enumerable: true,
                configurable: true,
                writable: true,
                value
            });
            return value;
        }
    });
    return target;
}

function parseDeprecatedPragmaMessage(lineText) {
    const source = String(lineText || '');
    if (source.indexOf('#') < 0) return null;
    if (!/deprecated/i.test(source)) return null;
    const pragma = parsePragmaDirectiveLine(source);
    if (pragma?.name !== 'deprecated') return null;
    return String(pragma.value || '').trim();
}

function applyDeprecatedPragmaToNextDecl(decls, message) {
    if (!Array.isArray(decls) || !decls.length || message == null) return false;
    const decl = decls.find(item => item && item.type !== 'define') || decls[0];
    if (!decl) return false;
    decl.deprecated = true;
    decl.deprecatedMessage = String(message || '');
    return true;
}

module.exports = {
    buildMayHaveDocsFlags,
    mayHaveDocsForLine,
    attachLazyDocs,
    parseDeprecatedPragmaMessage,
    applyDeprecatedPragmaToNextDecl
};
