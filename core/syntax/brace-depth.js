// Brace-depth tracking is a shared syntax utility used by parsing, include
// preprocessing, and some hover heuristics.
function createBraceDepthSyntaxCore(deps) {
    const {
        getActiveCtrlChar,
        isEscapedQuote
    } = deps;
    const depthSpecialCharRe = /[{}()\/]/;
    function hasDepthSpecialChar(line) {
        return depthSpecialCharRe.test(String(line || ''));
    }

    function computeLineDepths(lines, lineCtrlChars = [], lineIndex = null) {
        const lineCount = Array.isArray(lines) ? lines.length : 0;
        const depths = new Int32Array(lineCount);
        let braceD = 0, blockCmt = false;
        const defaultEscapeChar = getActiveCtrlChar();
        const indexedLineFlags = lineIndex?.lineFlags || null;
        const indexedDepthSpecialCharMask = indexedLineFlags
            ? (lineIndex?.depthSpecialCharMask || 0)
            : 0;
        const hasIndexedDepthSpecialChar = !indexedLineFlags && typeof lineIndex?.hasDepthSpecialCharLine === 'function'
            ? lineNo => lineIndex.hasDepthSpecialCharLine(lineNo)
            : null;
        for (let lineNo = 0; lineNo < lineCount; lineNo++) {
            const line = lines[lineNo];
            depths[lineNo] = braceD;
            if (!blockCmt) {
                if (indexedLineFlags && indexedDepthSpecialCharMask) {
                    if (!(indexedLineFlags[lineNo] & indexedDepthSpecialCharMask)) continue;
                } else if (hasIndexedDepthSpecialChar) {
                    if (!hasIndexedDepthSpecialChar(lineNo)) continue;
                } else if (!hasDepthSpecialChar(line)) {
                    continue;
                }
            }
            const escapeChar = lineCtrlChars[lineNo] || defaultEscapeChar;
            let parenD = 0, inStr = false, strCh = '', lineCmt = false;
            for (let j = 0; j < line.length; j++) {
                const code = line.charCodeAt(j);
                const nextCode = j + 1 < line.length ? line.charCodeAt(j + 1) : 0;
                if (blockCmt) { if (code === 42 && nextCode === 47) { blockCmt = false; j++; } continue; }
                if (lineCmt) break;
                if (inStr) { if (code === strCh && !isEscapedQuote(line, j, escapeChar)) inStr = false; continue; }
                if (code === 47 && nextCode === 47) { lineCmt = true; break; }
                if (code === 47 && nextCode === 42) { blockCmt = true; j++; continue; }
                if (code === 34 || code === 39) { inStr = true; strCh = code; continue; }
                if (code === 40) parenD++;
                else if (code === 41) {
                    if (parenD > 0) parenD--;
                }
                else if (code === 123 && parenD === 0) braceD++;
                else if (code === 125 && parenD === 0) {
                    if (braceD > 0) braceD--;
                }
            }
        }
        return depths;
    }

    return {
        computeLineDepths
    };
}

module.exports = { createBraceDepthSyntaxCore };
