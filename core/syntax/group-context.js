function computeLineStartGroupContextFlags(lines, options = {}) {
    const sourceLines = Array.isArray(lines) ? lines : [];
    const flags = new Uint8Array(sourceLines.length);
    const getLineText = typeof options.getLineText === 'function'
        ? options.getLineText
        : lineNumber => String(sourceLines[lineNumber] || '');
    let parenDepth = 0;
    let bracketDepth = 0;

    for (let lineNumber = 0; lineNumber < sourceLines.length; lineNumber++) {
        if (parenDepth > 0 || bracketDepth > 0) {
            flags[lineNumber] = 1;
        }

        const lineText = String(getLineText(lineNumber) || '');
        for (let index = 0; index < lineText.length; index++) {
            const char = lineText[index];
            if (char === '(') {
                parenDepth++;
            } else if (char === ')') {
                parenDepth = Math.max(0, parenDepth - 1);
            } else if (char === '[') {
                bracketDepth++;
            } else if (char === ']') {
                bracketDepth = Math.max(0, bracketDepth - 1);
            }
        }
    }

    return flags;
}

module.exports = { computeLineStartGroupContextFlags };
