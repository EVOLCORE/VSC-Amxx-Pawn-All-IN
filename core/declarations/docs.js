function mayHaveDocsForLine(rawLines, lineNumber) {
    if (!Array.isArray(rawLines) || lineNumber < 0 || lineNumber >= rawLines.length) return false;
    const ownLine = String(rawLines[lineNumber] || '');
    if (ownLine.includes('//') || ownLine.includes('/*') || ownLine.includes('*/')) return true;

    let blankGap = 0;
    for (let probeLine = lineNumber - 1; probeLine >= 0; probeLine--) {
        const trimmed = String(rawLines[probeLine] || '').trim();
        if (!trimmed) {
            blankGap++;
            if (blankGap > 1) break;
            continue;
        }
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            return true;
        }
        break;
    }
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
    const match = String(lineText || '').trim().match(/^#pragma\s+deprecated\b([\s\S]*)$/i);
    if (!match) return null;
    return match[1].trim();
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
