const { isPawnAssignmentCompareNeighbor } = require('./operators');

function createTopLevelScannerState() {
    return {
        parenDepth: 0,
        bracketDepth: 0,
        braceDepth: 0,
        inString: false,
        stringChar: ''
    };
}

function advanceTopLevelScannerState(source, index, state, options = {}) {
    const char = source[index];
    const isEscapedQuote = typeof options.isEscapedQuote === 'function'
        ? options.isEscapedQuote
        : null;
    const escapeChar = options.escapeChar || '';

    if (state.inString) {
        if (
            char === state.stringChar &&
            !(isEscapedQuote && isEscapedQuote(source, index, escapeChar))
        ) {
            state.inString = false;
        }
        return true;
    }
    if (char === '"' || char === "'") {
        state.inString = true;
        state.stringChar = char;
        return true;
    }
    if (char === '(') {
        state.parenDepth++;
        return true;
    }
    if (char === ')') {
        state.parenDepth = Math.max(0, state.parenDepth - 1);
        return true;
    }
    if (char === '[') {
        state.bracketDepth++;
        return true;
    }
    if (char === ']') {
        state.bracketDepth = Math.max(0, state.bracketDepth - 1);
        return true;
    }
    if (char === '{') {
        state.braceDepth++;
        return true;
    }
    if (char === '}') {
        state.braceDepth = Math.max(0, state.braceDepth - 1);
        return true;
    }
    return false;
}

function isTopLevelScannerState(state) {
    return !state.parenDepth && !state.bracketDepth && !state.braceDepth && !state.inString;
}

function findTopLevelChar(source = '', targetChar = '', options = {}) {
    const text = String(source || '');
    const state = createTopLevelScannerState();
    const startIndex = Math.max(0, Number.isInteger(options.startIndex) ? options.startIndex : 0);

    for (let index = startIndex; index < text.length; index++) {
        const char = text[index];
        if (advanceTopLevelScannerState(text, index, state, options)) continue;
        if (char === targetChar && isTopLevelScannerState(state)) return index;
    }

    return -1;
}

function findTopLevelSequence(source = '', target = '', options = {}) {
    const text = String(source || '');
    const needle = String(target || '');
    if (!needle) return -1;
    const state = createTopLevelScannerState();
    const startIndex = Math.max(0, Number.isInteger(options.startIndex) ? options.startIndex : 0);

    for (let index = startIndex; index <= text.length - needle.length; index++) {
        const char = text[index];
        if (advanceTopLevelScannerState(text, index, state, options)) continue;
        if (isTopLevelScannerState(state) && text.startsWith(needle, index)) return index;
    }

    return -1;
}

function findTopLevelSimpleAssignmentOperator(source = '', options = {}) {
    const text = String(source || '');
    const state = createTopLevelScannerState();

    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (advanceTopLevelScannerState(text, index, state, options)) continue;
        if (!isTopLevelScannerState(state)) continue;
        if (char !== '=') continue;
        if (isPawnAssignmentCompareNeighbor(text, index)) continue;
        return index;
    }

    return -1;
}

module.exports = {
    advanceTopLevelScannerState,
    createTopLevelScannerState,
    findTopLevelChar,
    findTopLevelSequence,
    findTopLevelSimpleAssignmentOperator,
    isTopLevelScannerState
};
