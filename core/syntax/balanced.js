function findBalancedGroupEnd(source = '', openIndex = 0, openChar = '(', closeChar = ')', options = {}) {
    const text = String(source || '');
    const start = Math.max(0, Number.isInteger(openIndex) ? openIndex : 0);
    if (!openChar || !closeChar || text[start] !== openChar) return -1;

    const escapeChar = options.escapeChar || '';
    const isEscapedQuote = typeof options.isEscapedQuote === 'function'
        ? options.isEscapedQuote
        : () => false;
    const shieldGroups = Array.isArray(options.shieldGroups)
        ? options.shieldGroups
            .map(group => ({
                open: String(group?.open || group?.[0] || ''),
                close: String(group?.close || group?.[1] || ''),
                depth: 0
            }))
            .filter(group => group.open && group.close && group.open !== openChar && group.close !== closeChar)
        : [];

    let depth = 0;
    let inString = false;
    let stringChar = '';

    const hasOpenShield = () => {
        for (const group of shieldGroups) {
            if (group.depth > 0) return true;
        }
        return false;
    };

    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (char === stringChar && !isEscapedQuote(text, index, escapeChar)) {
                inString = false;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            inString = true;
            stringChar = char;
            continue;
        }
        if (char === openChar) {
            depth++;
            continue;
        }

        let handledShield = false;
        for (const group of shieldGroups) {
            if (char === group.open) {
                group.depth++;
                handledShield = true;
                break;
            }
            if (char === group.close && group.depth > 0) {
                group.depth--;
                handledShield = true;
                break;
            }
        }
        if (handledShield) continue;

        if (char === closeChar) {
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
