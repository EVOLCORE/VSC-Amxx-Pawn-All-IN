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
        if (
            lineText.indexOf('(') < 0 &&
            lineText.indexOf(')') < 0 &&
            lineText.indexOf('[') < 0 &&
            lineText.indexOf(']') < 0
        ) {
            continue;
        }
        for (let index = 0; index < lineText.length; index++) {
            const code = lineText.charCodeAt(index);
            if (code === 40) {
                parenDepth++;
            } else if (code === 41) {
                parenDepth = Math.max(0, parenDepth - 1);
            } else if (code === 91) {
                bracketDepth++;
            } else if (code === 93) {
                bracketDepth = Math.max(0, bracketDepth - 1);
            }
        }
    }

    return flags;
}

module.exports = { computeLineStartGroupContextFlags };
