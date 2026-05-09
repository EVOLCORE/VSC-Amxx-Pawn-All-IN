function createDimensionSyntaxCore(deps = {}) {
    const {
        isEscapedQuote = null
    } = deps;

    function isQuoteEscaped(source, index) {
        if (typeof isEscapedQuote === 'function') {
            return isEscapedQuote(source, index);
        }
        let slashCount = 0;
        for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) {
            slashCount++;
        }
        return (slashCount % 2) === 1;
    }

    function readDimensionGroup(source, openIndex) {
        const text = String(source || '');
        if (text[openIndex] !== '[') return null;
        let depth = 0;
        let inString = false;
        let stringChar = '';

        for (let index = openIndex; index < text.length; index++) {
            const char = text[index];
            if (inString) {
                if (char === stringChar && !isQuoteEscaped(text, index)) {
                    inString = false;
                }
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                continue;
            }
            if (char === '[') {
                depth++;
                continue;
            }
            if (char === ']') {
                depth--;
                if (depth === 0) {
                    return {
                        text: text.slice(openIndex, index + 1),
                        inner: text.slice(openIndex + 1, index),
                        start: openIndex,
                        end: index + 1
                    };
                }
            }
        }

        return null;
    }

    function readDimensionGroups(source, startIndex = 0) {
        const text = String(source || '');
        const groups = [];
        let cursor = Math.max(0, startIndex | 0);
        while (cursor < text.length) {
            while (cursor < text.length && /\s/.test(text[cursor] || '')) cursor++;
            if (text[cursor] !== '[') break;
            const group = readDimensionGroup(text, cursor);
            if (!group) break;
            groups.push(group);
            cursor = group.end;
        }
        return { groups, end: cursor };
    }

    function parseDimsParts(dimsStr) {
        return readDimensionGroups(dimsStr, 0).groups.map(group => group.inner.trim());
    }

    function parseLeadingDims(source) {
        const result = readDimensionGroups(source, 0);
        const dims = result.groups.map(group => group.text).join('');
        return {
            dims,
            rest: String(source || '').slice(result.end).trimStart()
        };
    }

    return {
        parseDimsParts,
        parseLeadingDims,
        readDimensionGroup,
        readDimensionGroups
    };
}

module.exports = { createDimensionSyntaxCore };
