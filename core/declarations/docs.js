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

const DOC_SCAN_NON_EMPTY = 1 << 0;
const DOC_SCAN_HAS_COMMENT_MARKER = 1 << 1;
const DOC_SCAN_STARTS_ATTACHABLE_DOC = 1 << 2;

function analyzeDocScanLine(line) {
    const source = typeof line === 'string' ? line : String(line || '');
    let firstNonWhitespaceIndex = 0;
    while (firstNonWhitespaceIndex < source.length) {
        if (!isDocScanWhitespaceCode(source.charCodeAt(firstNonWhitespaceIndex))) {
            break;
        }
        firstNonWhitespaceIndex++;
    }
    let flags = firstNonWhitespaceIndex < source.length ? DOC_SCAN_NON_EMPTY : 0;
    const slashIndex = source.indexOf('/');
    if (slashIndex >= 0 && (
        source.indexOf('//', slashIndex) >= 0 ||
        source.indexOf('/*', slashIndex) >= 0 ||
        source.indexOf('*/', Math.max(0, slashIndex - 1)) >= 0
    )) {
        flags |= DOC_SCAN_HAS_COMMENT_MARKER;
    }
    if (flags & DOC_SCAN_NON_EMPTY) {
        const firstChar = source[firstNonWhitespaceIndex];
        const nextChar = source[firstNonWhitespaceIndex + 1] || '';
        if (firstChar === '*' || (firstChar === '/' && (nextChar === '/' || nextChar === '*'))) {
            flags |= DOC_SCAN_STARTS_ATTACHABLE_DOC;
        }
    }
    return flags;
}

function scanMayHaveDocsFlags(rawLines, state, targetLine) {
    for (let lineNumber = state.computedThrough + 1; lineNumber <= targetLine; lineNumber++) {
        const line = rawLines[lineNumber] || '';
        const scanFlags = analyzeDocScanLine(line);
        state.flags[lineNumber] = ((scanFlags & DOC_SCAN_HAS_COMMENT_MARKER) || state.previousAttachableDoc) ? 2 : 1;

        if (!(scanFlags & DOC_SCAN_NON_EMPTY)) {
            if (state.previousAttachableDoc) {
                state.blankGap++;
                if (state.blankGap > 1) {
                    state.previousAttachableDoc = false;
                }
            }
            state.computedThrough = lineNumber;
            continue;
        }

        if (scanFlags & DOC_SCAN_STARTS_ATTACHABLE_DOC) {
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
