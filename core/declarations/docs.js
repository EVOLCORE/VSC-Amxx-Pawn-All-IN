const { parsePragmaDirectiveLine } = require('../syntax/pragma-directives');

const mayHaveDocsCacheByLines = new WeakMap();

function mayHaveDocsForLine(rawLines, lineNumber) {
    if (!Array.isArray(rawLines) || lineNumber < 0 || lineNumber >= rawLines.length) return false;
    let cachedFlags = mayHaveDocsCacheByLines.get(rawLines);
    if (!cachedFlags || cachedFlags.length !== rawLines.length) {
        cachedFlags = new Uint8Array(rawLines.length);
        mayHaveDocsCacheByLines.set(rawLines, cachedFlags);
    }
    const cached = cachedFlags[lineNumber];
    if (cached) return cached === 2;

    const ownLine = String(rawLines[lineNumber] || '');
    if (ownLine.includes('//') || ownLine.includes('/*') || ownLine.includes('*/')) {
        cachedFlags[lineNumber] = 2;
        return true;
    }

    let blankGap = 0;
    for (let probeLine = lineNumber - 1; probeLine >= 0; probeLine--) {
        const trimmed = String(rawLines[probeLine] || '').trim();
        if (!trimmed) {
            blankGap++;
            if (blankGap > 1) break;
            continue;
        }
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            cachedFlags[lineNumber] = 2;
            return true;
        }
        break;
    }
    cachedFlags[lineNumber] = 1;
    return false;
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
    mayHaveDocsForLine,
    attachLazyDocs,
    parseDeprecatedPragmaMessage,
    applyDeprecatedPragmaToNextDecl
};
