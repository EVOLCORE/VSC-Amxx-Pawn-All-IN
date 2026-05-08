// Shared literal/text helpers used by hover rendering and call/validation logic.
function createLiteralSyntaxCore(deps) {
    const {
        getActiveCtrlChar,
        isEscapedQuote
    } = deps;

    function decodePawnStringLiteral(expr, escapeChar = getActiveCtrlChar()) {
        const source = String(expr || '').trim();
        if (!source.startsWith('"') && !source.startsWith("'")) return null;
        const quote = source[0];
        let decoded = '';

        for (let i = 1; i < source.length; i++) {
            const c = source[i];
            if (c === quote && !isEscapedQuote(source, i, escapeChar)) return decoded;
            if (c === escapeChar && i + 1 < source.length) {
                const next = source[++i];
                if (next === 'n') decoded += '\n';
                else if (next === 't') decoded += '\t';
                else decoded += next;
                continue;
            }
            decoded += c;
        }

        return null;
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
