function readPawnLiteralCharValue(source, index, escapeChar = '') {
    const text = String(source || '');
    if (index >= text.length) return null;

    const char = text[index];
    if (!escapeChar || char !== escapeChar) {
        const value = text.codePointAt(index);
        if (value == null) return null;
        return {
            value,
            end: index + String.fromCodePoint(value).length
        };
    }

    index++;
    if (index >= text.length) return null;
    const escaped = text[index];
    if (escaped === escapeChar) return { value: escaped.codePointAt(0), end: index + 1 };
    if (escaped === 'a') return { value: 7, end: index + 1 };
    if (escaped === 'b') return { value: 8, end: index + 1 };
    if (escaped === 'e') return { value: 27, end: index + 1 };
    if (escaped === 'f') return { value: 12, end: index + 1 };
    if (escaped === 'n') return { value: 10, end: index + 1 };
    if (escaped === 'r') return { value: 13, end: index + 1 };
    if (escaped === 't') return { value: 9, end: index + 1 };
    if (escaped === 'v') return { value: 11, end: index + 1 };
    if (escaped === '\'' || escaped === '"' || escaped === '%') {
        return { value: escaped.codePointAt(0), end: index + 1 };
    }
    if (escaped === 'x') {
        index++;
        const digitStart = index;
        let value = 0;
        while (index < text.length && /[0-9a-fA-F]/.test(text[index])) {
            value = (value << 4) + Number.parseInt(text[index], 16);
            index++;
        }
        if (index === digitStart) return null;
        if (text[index] === ';') index++;
        return { value, end: index };
    }
    if (/[0-9]/.test(escaped)) {
        let value = 0;
        while (index < text.length && /[0-9]/.test(text[index])) {
            value = value * 10 + Number.parseInt(text[index], 10);
            index++;
        }
        if (text[index] === ';') index++;
        return { value, end: index };
    }
    return null;
}

function evaluatePawnCharacterLiteralValue(literal, escapeChar = '') {
    const text = String(literal || '');
    if (text.length < 3 || text[0] !== '\'' || text[text.length - 1] !== '\'') return null;
    const parsed = readPawnLiteralCharValue(text, 1, escapeChar);
    if (!parsed || parsed.end !== text.length - 1) return null;
    if (parsed.value < 0 || parsed.value > 0xff) return null;
    return parsed.value;
}

function replaceNumericCharacterLiteralsForValidation(source, escapeChar = '') {
    const text = String(source || '');
    if (text.indexOf('\'') < 0) return text;
    let output = '';
    let cursor = 0;
    for (let index = 0; index < text.length; index++) {
        if (text[index] !== '\'') continue;
        const parsed = readPawnLiteralCharValue(text, index + 1, escapeChar);
        if (!parsed || text[parsed.end] !== '\'') continue;
        if (parsed.value < 0 || parsed.value > 0xff) continue;
        output += text.slice(cursor, index) + '0';
        cursor = parsed.end + 1;
        index = parsed.end;
    }
    return cursor > 0 ? output + text.slice(cursor) : text;
}

module.exports = {
    evaluatePawnCharacterLiteralValue,
    replaceNumericCharacterLiteralsForValidation
};
