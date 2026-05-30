function findBalancedGroupEnd(source = '', openIndex = 0, openChar = '(', closeChar = ')', options = {}) {
    const text = String(source || '');
    const start = Math.max(0, Number.isInteger(openIndex) ? openIndex : 0);
    if (!openChar || !closeChar) return -1;
    const openText = String(openChar);
    const closeText = String(closeChar);
    const openCode = openText.charCodeAt(0);
    const closeCode = closeText.charCodeAt(0);
    if (text.charCodeAt(start) !== openCode) return -1;

    const escapeChar = options.escapeChar || '';
    const isEscapedQuote = typeof options.isEscapedQuote === 'function'
        ? options.isEscapedQuote
        : () => false;
    const shieldGroups = Array.isArray(options.shieldGroups)
        ? options.shieldGroups
            .map(group => ({
                open: String(group?.open || group?.[0] || ''),
                close: String(group?.close || group?.[1] || ''),
                openCode: String(group?.open || group?.[0] || '').charCodeAt(0),
                closeCode: String(group?.close || group?.[1] || '').charCodeAt(0),
                depth: 0
            }))
            .filter(group => group.open && group.close && group.open !== openText && group.close !== closeText)
        : [];

    let depth = 0;
    let inString = false;
    let stringChar = '';

    if (!shieldGroups.length) {
        if (openText !== closeText) {
            const firstCloseIndex = text.indexOf(closeText, start + 1);
            if (firstCloseIndex < 0) return -1;
            const firstNestedOpenIndex = text.indexOf(openText, start + 1);
            const firstDoubleQuoteIndex = text.indexOf('"', start + 1);
            const firstSingleQuoteIndex = text.indexOf("'", start + 1);
            if (
                (firstNestedOpenIndex < 0 || firstNestedOpenIndex > firstCloseIndex) &&
                (firstDoubleQuoteIndex < 0 || firstDoubleQuoteIndex > firstCloseIndex) &&
                (firstSingleQuoteIndex < 0 || firstSingleQuoteIndex > firstCloseIndex)
            ) {
                return firstCloseIndex;
            }
        }
        if (
            openText.length === 1 &&
            closeText.length === 1 &&
            openText !== closeText &&
            text.indexOf('"', start + 1) < 0 &&
            text.indexOf("'", start + 1) < 0
        ) {
            for (let index = start; index < text.length; index++) {
                const code = text.charCodeAt(index);
                if (code === openCode) {
                    depth++;
                    continue;
                }
                if (code === closeCode) {
                    depth--;
                    if (depth === 0) return index;
                    if (depth < 0) return -1;
                }
            }
            return -1;
        }
        for (let index = start; index < text.length; index++) {
            const code = text.charCodeAt(index);
            if (inString) {
                if (code === stringChar && !isEscapedQuote(text, index, escapeChar)) {
                    inString = false;
                }
                continue;
            }
            if (code === 34 || code === 39) {
                inString = true;
                stringChar = code;
                continue;
            }
            if (code === openCode) {
                depth++;
                continue;
            }
            if (code === closeCode) {
                depth--;
                if (depth === 0) return index;
                if (depth < 0) return -1;
            }
        }
        return -1;
    }

    const hasOpenShield = () => {
        for (const group of shieldGroups) {
            if (group.depth > 0) return true;
        }
        return false;
    };

    for (let index = start; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (inString) {
            if (code === stringChar && !isEscapedQuote(text, index, escapeChar)) {
                inString = false;
            }
            continue;
        }
        if (code === 34 || code === 39) {
            inString = true;
            stringChar = code;
            continue;
        }
        if (code === openCode) {
            depth++;
            continue;
        }

        let handledShield = false;
        for (const group of shieldGroups) {
            if (code === group.openCode) {
                group.depth++;
                handledShield = true;
                break;
            }
            if (code === group.closeCode && group.depth > 0) {
                group.depth--;
                handledShield = true;
                break;
            }
        }
        if (handledShield) continue;

        if (code === closeCode) {
            if (hasOpenShield()) continue;
            depth--;
            if (depth === 0) return index;
            if (depth < 0) return -1;
        }
    }

    return -1;
}

module.exports = {
    findBalancedGroupEnd
};
