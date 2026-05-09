// Shared literal/text helpers used by hover rendering and call/validation logic.
function createLiteralSyntaxCore(deps) {
    const {
        getActiveCtrlChar,
        isEscapedQuote
    } = deps;

    function decodePawnStringLiteral(expr, escapeChar = getActiveCtrlChar()) {
        const source = String(expr || '').trim();
        if (!source.startsWith('"') && !source.startsWith("'")) return null;
        let decoded = '';
        let cursor = 0;

        while (cursor < source.length) {
            while (cursor < source.length && /\s/.test(source[cursor])) cursor++;
            if (cursor >= source.length) return decoded;

            const quote = source[cursor];
            if (quote !== '"' && quote !== "'") return null;
            let part = '';
            let closed = false;

            for (let i = cursor + 1; i < source.length; i++) {
                const c = source[i];
                if (c === quote && !isEscapedQuote(source, i, escapeChar)) {
                    decoded += part;
                    cursor = i + 1;
                    closed = true;
                    break;
                }
                if (c === escapeChar && i + 1 < source.length) {
                    const next = source[++i];
                    if (next === 'n') part += '\n';
                    else if (next === 't') part += '\t';
                    else part += next;
                    continue;
                }
                part += c;
            }

            if (!closed) return null;
        }

        return decoded;
    }

    function measurePawnStringLiteral(expr, escapeChar = getActiveCtrlChar()) {
        const decoded = decodePawnStringLiteral(expr, escapeChar);
        if (decoded == null) return null;
        return {
            chars: Array.from(decoded).length,
            bytes: Buffer.byteLength(decoded, 'utf8'),
            bytesWithTerminator: Buffer.byteLength(decoded, 'utf8') + 1
        };
    }

    function isVariadicParam(paramText) {
        const trimmed = String(paramText || '').trim();
        return trimmed === '...' || trimmed.endsWith('...');
    }

    return {
        decodePawnStringLiteral,
        measurePawnStringLiteral,
        isVariadicParam
    };
}

module.exports = { createLiteralSyntaxCore };
