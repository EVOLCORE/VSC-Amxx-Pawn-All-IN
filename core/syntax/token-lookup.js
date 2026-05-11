// Token lookup helpers sit in syntax because they are language-mechanics
// utilities shared by hover, navigation, declaration guards, and validation.
const { isPawnIdentifierStartChar } = require('./identifiers');

function createLookupTokenSyntaxCore(deps) {
    const {
        vscode,
        getActiveCtrlChar,
        isEscapedQuote,
        DEFAULT_CTRL_CHAR,
        OPERATOR_SYMBOLS
    } = deps;

    function isLinePositionInsideCommentOrString(lineText, column, escapeChar = getActiveCtrlChar()) {
        let inStr = false;
        let strCh = '';
        let blockComment = false;

        for (let i = 0; i < Math.min(column, lineText.length); i++) {
            const c = lineText[i];
            const n = lineText[i + 1] || '';

            if (blockComment) {
                if (c === '*' && n === '/') {
                    blockComment = false;
                    i++;
                }
                continue;
            }

            if (inStr) {
                if (c === strCh && !isEscapedQuote(lineText, i, escapeChar)) inStr = false;
                continue;
            }

            if (c === '"' || c === "'") {
                inStr = true;
                strCh = c;
                continue;
            }

            if (c === '/' && n === '/') return true;
            if (c === '/' && n === '*') {
                blockComment = true;
                i++;
            }
        }

        return inStr || blockComment;
    }

    function findOperatorLookupTokenAtPosition(document, position, ctrlCharResolver = null) {
        const lineText = document.lineAt(position.line).text;
        const column = Math.min(position.character, lineText.length);
        const escapeChar = ctrlCharResolver?.ctrlCharAtLine(position.line) || DEFAULT_CTRL_CHAR;
        if (isLinePositionInsideCommentOrString(lineText, column, escapeChar)) return null;
        const operatorNameRe = /operator(?:<<=|>>=|==|!=|<=|>=|\+\+|--|&&|\|\||<<|>>|[%*/+\-<>=!&|^~]+)/g;

        let match;
        while ((match = operatorNameRe.exec(lineText))) {
            const start = match.index;
            const end = start + match[0].length;
            if (column >= start && column < end) {
                return {
                    text: match[0],
                    range: new vscode.Range(position.line, start, position.line, end),
                    isOperator: true
                };
            }
        }

        for (const symbol of OPERATOR_SYMBOLS) {
            const len = symbol.length;
            for (let start = Math.max(0, column - len); start <= column; start++) {
                if (start + len > lineText.length) continue;
                if (lineText.slice(start, start + len) !== symbol) continue;
                if (column < start || column >= start + len) continue;
                if (
                    symbol === '&' &&
                    isPawnIdentifierStartChar(lineText[start + 1] || '') &&
                    !/[\w\])}]/.test(lineText[start - 1] || '')
                ) {
                    continue;
                }
                return {
                    text: `operator${symbol}`,
                    range: new vscode.Range(position.line, start, position.line, start + len),
                    isOperator: true
                };
            }
        }

        return null;
    }

    function getLookupTokenAtPosition(document, position, options = {}) {
        const includeOperators = options.includeOperators !== false;
        const ctrlCharResolver = options.ctrlCharResolver || null;
        if (includeOperators) {
            const operatorToken = findOperatorLookupTokenAtPosition(document, position, ctrlCharResolver);
            if (operatorToken) return operatorToken;
        }

        const range = document.getWordRangeAtPosition(position);
        if (!range) return null;
        return {
            text: document.getText(range),
            range,
            isOperator: false
        };
    }

    return {
        isLinePositionInsideCommentOrString,
        getLookupTokenAtPosition
    };
}

module.exports = { createLookupTokenSyntaxCore };
