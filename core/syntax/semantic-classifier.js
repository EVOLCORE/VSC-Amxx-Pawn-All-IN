function createSemanticSyntaxCore(deps = {}) {
    const {
        isEscapedQuote,
        isIdentifierStartChar,
        isIdentifierContinueChar,
        maxExpressionLength = 1024
    } = deps;

    const KEYWORD_UNARY_OPERATORS = new Set(['sizeof', 'tagof', 'defined', 'char']);
    const FORBIDDEN_TAG_CASTS = new Set([
        'if', 'for', 'while', 'switch', 'case', 'default', 'return', 'new',
        'static', 'const', 'stock', 'public', 'private', 'native', 'forward',
        'enum', 'state', 'goto', 'assert', 'sleep', 'exit', 'true', 'false',
        'cellmin', 'cellmax', 'char', 'sizeof', 'tagof', 'defined'
    ]);
    const ASSIGNMENT_OPERATORS = new Set([
        '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='
    ]);
    const BINARY_PRECEDENCE = new Map([
        ['||', 1],
        ['&&', 2],
        ['|', 3],
        ['^', 4],
        ['&', 5],
        ['==', 6],
        ['!=', 6],
        ['<', 7],
        ['<=', 7],
        ['>', 7],
        ['>=', 7],
        ['<<', 8],
        ['>>', 8],
        ['+', 9],
        ['-', 9],
        ['*', 10],
        ['/', 10],
        ['%', 10]
    ]);
    const PREFIX_OPERATORS = new Set(['++', '--', '+', '-', '!', '~']);
    const POSTFIX_OPERATORS = new Set(['++', '--']);
    const OPERATORS = [
        '<<=', '>>=', '++', '--', '&&', '||', '<<', '>>', '<=', '>=', '==', '!=',
        '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
        '=', '+', '-', '*', '/', '%', '&', '|', '^', '<', '>', '!', '~'
    ];
    const PARSED_EXPRESSION_CACHE_LIMIT = 8192;
    const PARSED_EXPRESSION_CACHE_MAX_CHARS = 192;
    const parsedExpressionCache = new Map();

    const isWhitespaceChar = char =>
        char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f' || char === '\v';
    const isDigitChar = char => char >= '0' && char <= '9';
    const isHexDigitChar = char =>
        (char >= '0' && char <= '9') ||
        (char >= 'a' && char <= 'f') ||
        (char >= 'A' && char <= 'F');
    const isIdentifierStart = char => (
        typeof isIdentifierStartChar === 'function'
            ? isIdentifierStartChar(char || '')
            : /[A-Za-z_@]/.test(char || '')
    );
    const isIdentifierContinue = char => (
        typeof isIdentifierContinueChar === 'function'
            ? isIdentifierContinueChar(char || '')
            : /[A-Za-z0-9_@]/.test(char || '')
    );
    const isQuoteEscaped = (source, index, escapeChar) => (
        typeof isEscapedQuote === 'function'
            ? isEscapedQuote(source, index, escapeChar)
            : false
    );

    function readIdentifierAt(source, index) {
        if (!isIdentifierStart(source[index])) return null;
        let end = index + 1;
        while (end < source.length && isIdentifierContinue(source[end])) end++;
        return {
            type: 'identifier',
            value: source.slice(index, end),
            start: index,
            end
        };
    }

    function readNumberAt(source, index) {
        if (source[index] === '0' && (source[index + 1] === 'x' || source[index + 1] === 'X')) {
            let end = index + 2;
            while (end < source.length && isHexDigitChar(source[end])) end++;
            if (end === index + 2) return null;
            if (isIdentifierContinue(source[end])) return null;
            return { type: 'number', value: source.slice(index, end), start: index, end };
        }

        let end = index;
        let sawDigit = false;
        while (end < source.length && isDigitChar(source[end])) {
            end++;
            sawDigit = true;
        }
        if (source[end] === '.') {
            end++;
            while (end < source.length && isDigitChar(source[end])) {
                end++;
                sawDigit = true;
            }
        }
        if (!sawDigit) return null;
        if (source[end] === 'e' || source[end] === 'E') {
            let expEnd = end + 1;
            if (source[expEnd] === '+' || source[expEnd] === '-') expEnd++;
            const expDigitsStart = expEnd;
            while (expEnd < source.length && isDigitChar(source[expEnd])) expEnd++;
            if (expEnd === expDigitsStart) return null;
            end = expEnd;
        }
        if (isIdentifierContinue(source[end])) return null;
        return { type: 'number', value: source.slice(index, end), start: index, end };
    }

    function readQuotedLiteralAt(source, index, escapeChar) {
        const quote = source[index];
        if (quote !== '"' && quote !== "'") return null;
        for (let end = index + 1; end < source.length; end++) {
            if (source[end] === quote && !isQuoteEscaped(source, end, escapeChar)) {
                return {
                    type: quote === '"' ? 'string' : 'char',
                    value: source.slice(index, end + 1),
                    start: index,
                    end: end + 1
                };
            }
        }
        return {
            type: 'invalid',
            value: source.slice(index),
            start: index,
            end: source.length,
            reason: 'unterminated-string'
        };
    }

    function readOperatorAt(source, index) {
        for (const operator of OPERATORS) {
            if (source.startsWith(operator, index)) {
                return {
                    type: 'operator',
                    value: operator,
                    start: index,
                    end: index + operator.length
                };
            }
        }
        return null;
    }

    function tokenizePawnExpression(source, options = {}) {
        const text = String(source || '');
        const escapeChar = options.escapeChar || '';
        const tokens = [];
        let index = 0;
        while (index < text.length) {
            const char = text[index];
            if (isWhitespaceChar(char)) {
                index++;
                continue;
            }

            const quoted = readQuotedLiteralAt(text, index, escapeChar);
            if (quoted) {
                tokens.push(quoted);
                index = quoted.end;
                continue;
            }

            const number = readNumberAt(text, index);
            if (number) {
                tokens.push(number);
                index = number.end;
                continue;
            }

            const identifier = readIdentifierAt(text, index);
            if (identifier) {
                tokens.push(identifier);
                index = identifier.end;
                continue;
            }

            const operator = readOperatorAt(text, index);
            if (operator) {
                tokens.push(operator);
                index = operator.end;
                continue;
            }

            if ('()[]{},?:.'.includes(char)) {
                tokens.push({ type: 'punctuation', value: char, start: index, end: index + 1 });
                index++;
                continue;
            }

            tokens.push({
                type: 'invalid',
                value: char,
                start: index,
                end: index + 1,
                reason: 'unexpected-character'
            });
            index++;
        }
        tokens.push({ type: 'eof', value: '', start: text.length, end: text.length });
        return tokens;
    }

    function isWholeDelimitedSource(source, openChar, closeChar, options = {}) {
        const text = String(source || '').trim();
        if (!text.startsWith(openChar) || !text.endsWith(closeChar)) return false;
        const escapeChar = options.escapeChar || '';
        let depth = 0;
        let inStr = false;
        let strCh = '';
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                if (char === strCh && !isQuoteEscaped(text, index, escapeChar)) inStr = false;
                continue;
            }
            if (char === '"' || char === "'") {
                inStr = true;
                strCh = char;
                continue;
            }
            if (char === openChar) {
                depth++;
                continue;
            }
            if (char === closeChar) {
                depth--;
                if (depth === 0 && index < text.length - 1) return false;
                if (depth < 0) return false;
            }
        }
        return depth === 0;
    }

    function splitTopLevelDelimitedItems(source, options = {}) {
        const text = String(source || '');
        if (!text.trim()) return [];
        const escapeChar = options.escapeChar || '';
        const keepEmpty = options.keepEmpty === true;
        const parts = [];
        let depth = 0;
        let inStr = false;
        let strCh = '';
        let start = 0;
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                if (char === strCh && !isQuoteEscaped(text, index, escapeChar)) inStr = false;
                continue;
            }
            if (char === '"' || char === "'") {
                inStr = true;
                strCh = char;
                continue;
            }
            if (char === '[' || char === '(' || char === '{') {
                depth++;
                continue;
            }
            if (char === ']' || char === ')' || char === '}') {
                depth--;
                continue;
            }
            if (char === ',' && depth === 0) {
                const part = text.slice(start, index).trim();
                if (part || keepEmpty) parts.push(part);
                start = index + 1;
            }
        }
        const last = text.slice(start).trim();
        if (last || keepEmpty) parts.push(last);
        while (parts.length && !String(parts[parts.length - 1] || '').trim()) {
            parts.pop();
        }
        return parts;
    }

    function createParser(tokens, options = {}) {
        let cursor = 0;
        const buildAst = options.buildAst === true;
        const allowAssignment = options.allowAssignment !== false;
        const fastNode = { kind: 'expression' };

        const current = () => tokens[cursor] || tokens[tokens.length - 1];
        const advance = () => tokens[cursor++] || tokens[tokens.length - 1];
        const isValue = value => current().value === value;
        const isType = type => current().type === type;
        const consume = value => {
            if (!isValue(value)) return null;
            return advance();
        };
        const expect = value => {
            const token = consume(value);
            if (!token) throw createParseError('expected-token', current());
            return token;
        };
        const node = (kind, props = {}, startToken = null, endToken = null) => {
            if (!buildAst) return fastNode;
            const start = (() => {
                if (kind === 'binary' || kind === 'assignment') return props.left?.start ?? startToken?.start;
                if (kind === 'ternary') return props.condition?.start ?? startToken?.start;
                if (kind === 'call') return props.callee?.start ?? startToken?.start;
                if (kind === 'index' || kind === 'postfix') return props.expr?.start ?? startToken?.start;
                return startToken?.start ?? props.expr?.start ?? current().start;
            })();
            const end = (() => {
                if (kind === 'binary' || kind === 'assignment') return props.right?.end ?? endToken?.end;
                if (kind === 'ternary') return props.whenFalse?.end ?? endToken?.end;
                if (kind === 'postfix') return endToken?.end ?? props.expr?.end;
                if (kind === 'tag-cast' || kind === 'unary') return props.expr?.end ?? endToken?.end;
                if (kind === 'index') return endToken?.end ?? props.index?.end;
                if (kind === 'call') return endToken?.end ?? props.args?.[props.args.length - 1]?.end;
                if (kind === 'group') return endToken?.end ?? props.expr?.end;
                if (kind === 'brace-literal') return endToken?.end ?? props.elements?.[props.elements.length - 1]?.end;
                return endToken?.end ?? props.expr?.end ?? start;
            })();
            return { kind, ...props, start, end };
        };

        function createParseError(reason, token) {
            const error = new Error(reason);
            error.reason = reason;
            error.index = token?.start ?? 0;
            error.token = token || null;
            return error;
        }

        function parseExpression() {
            return parseAssignment();
        }

        function parseAssignment() {
            const left = parseConditional();
            const token = current();
            if (!allowAssignment || token.type !== 'operator' || !ASSIGNMENT_OPERATORS.has(token.value)) {
                return left;
            }
            advance();
            const right = parseAssignment();
            return node('assignment', { operator: token.value, left, right }, token, token);
        }

        function parseConditional() {
            const condition = parseBinary(1);
            if (!consume('?')) return condition;
            const whenTrue = parseExpression();
            expect(':');
            const whenFalse = parseConditional();
            return node('ternary', { condition, whenTrue, whenFalse }, null, null);
        }

        function parseBinary(minPrecedence) {
            let left = parseUnary();
            while (true) {
                const token = current();
                const precedence = token.type === 'operator'
                    ? BINARY_PRECEDENCE.get(token.value) || 0
                    : 0;
                if (precedence < minPrecedence) break;
                advance();
                const right = parseBinary(precedence + 1);
                left = node('binary', { operator: token.value, left, right }, token, token);
            }
            return left;
        }

        function parseUnary() {
            const token = current();
            if (
                (token.type === 'operator' && PREFIX_OPERATORS.has(token.value)) ||
                (token.type === 'identifier' && KEYWORD_UNARY_OPERATORS.has(token.value))
            ) {
                advance();
                const expr = parseUnary();
                return node('unary', { operator: token.value, expr }, token, token);
            }
            return parsePostfix();
        }

        function parsePostfix() {
            let expr = parsePrimary();
            while (true) {
                const token = current();
                if (consume('[')) {
                    const indexExpr = parseExpression();
                    const close = expect(']');
                    expr = node('index', { expr, index: indexExpr, access: '[]' }, token, close);
                    continue;
                }
                if (consume('{')) {
                    const indexExpr = parseExpression();
                    const close = expect('}');
                    expr = node('index', { expr, index: indexExpr, access: '{}' }, token, close);
                    continue;
                }
                if (consume('(')) {
                    const { values: args, closeToken } = parseDelimitedExpressions(')', {
                        allowNamedArgs: true,
                        allowTrailingComma: false
                    });
                    expr = node('call', { callee: expr, args, openToken: token, closeToken }, token, closeToken || token);
                    continue;
                }
                if (token.type === 'operator' && POSTFIX_OPERATORS.has(token.value)) {
                    advance();
                    expr = node('postfix', { operator: token.value, expr }, token, token);
                    continue;
                }
                if (token.type === 'identifier' && token.value === 'char') {
                    advance();
                    expr = node('postfix', { operator: token.value, expr }, token, token);
                    continue;
                }
                break;
            }
            return expr;
        }

        function parseDelimitedExpressions(endToken, listOptions = {}) {
            const values = [];
            const emptyClose = consume(endToken);
            if (emptyClose) return { values, closeToken: emptyClose };
            while (true) {
                const namedDot = listOptions.allowNamedArgs && consume('.');
                if (namedDot) {
                    if (!isType('identifier')) throw createParseError('expected-named-arg', current());
                    const name = advance();
                    expect('=');
                    const expr = parseExpression();
                    values.push(node('named-argument', { name: name.value, expr }, namedDot, null));
                } else {
                    values.push(parseExpression());
                }
                const close = consume(endToken);
                if (close) return { values, closeToken: close };
                expect(',');
                if (isValue(endToken)) {
                    if (listOptions.allowTrailingComma) {
                        const trailingClose = advance();
                        return { values, closeToken: trailingClose };
                    }
                    throw createParseError('trailing-comma', current());
                }
            }
        }

        function parsePrimary() {
            const token = current();
            if (token.type === 'invalid') throw createParseError(token.reason || 'invalid-token', token);
            if (token.type === 'number' || token.type === 'string' || token.type === 'char') {
                advance();
                return node(token.type, { value: token.value }, token, token);
            }
            if (token.type === 'identifier') {
                advance();
                if (
                    current().value === ':' &&
                    tokens[cursor + 1]?.value !== ':' &&
                    !FORBIDDEN_TAG_CASTS.has(token.value)
                ) {
                    advance();
                    const expr = parseUnary();
                    return node('tag-cast', { tag: token.value, expr }, token, token);
                }
                return node('identifier', { name: token.value }, token, token);
            }
            if (consume('(')) {
                const expr = parseExpression();
                const close = expect(')');
                return node('group', { expr }, token, close);
            }
            if (consume('{')) {
                const { values: elements, closeToken } = parseDelimitedExpressions('}', {
                    allowNamedArgs: false,
                    allowTrailingComma: true
                });
                return node('brace-literal', { elements }, token, closeToken || token);
            }
            throw createParseError('expected-expression', token);
        }

        function skipLeadingBinaryOperators() {
            while (true) {
                const token = current();
                if (token.type !== 'operator' || !BINARY_PRECEDENCE.has(token.value)) return;
                advance();
            }
        }

        return {
            parseExpression,
            skipLeadingBinaryOperators,
            current
        };
    }

    function getParseExpressionCacheKey(text, options = {}) {
        return [
            options.escapeChar || '',
            options.buildAst === true ? '1' : '0',
            options.allowAssignment === false ? '0' : '1',
            options.allowLeadingBinaryOperator ? '1' : '0',
            text
        ].join('\u0001');
    }

    function cacheParsedExpressionResult(key, result) {
        parsedExpressionCache.set(key, result);
        while (parsedExpressionCache.size > PARSED_EXPRESSION_CACHE_LIMIT) {
            parsedExpressionCache.delete(parsedExpressionCache.keys().next().value);
        }
        return result;
    }

    function parsePawnExpression(source, options = {}) {
        const text = String(source || '').trim();
        if (!text || text.length > maxExpressionLength) {
            return { ok: false, kind: 'empty', reason: 'empty' };
        }
        const canUseCache = text.length <= PARSED_EXPRESSION_CACHE_MAX_CHARS;
        const cacheKey = canUseCache ? getParseExpressionCacheKey(text, options) : '';
        if (canUseCache && parsedExpressionCache.has(cacheKey)) {
            const cached = parsedExpressionCache.get(cacheKey);
            parsedExpressionCache.delete(cacheKey);
            parsedExpressionCache.set(cacheKey, cached);
            return cached;
        }
        const tokens = tokenizePawnExpression(text, options);
        const invalid = tokens.find(token => token.type === 'invalid');
        if (invalid) {
            const result = {
                ok: false,
                kind: 'invalid-expression',
                reason: invalid.reason || 'invalid-token',
                index: invalid.start
            };
            return canUseCache ? cacheParsedExpressionResult(cacheKey, result) : result;
        }

        try {
            const parser = createParser(tokens, options);
            if (options.allowLeadingBinaryOperator) {
                parser.skipLeadingBinaryOperators();
            }
            const ast = parser.parseExpression();
            const token = parser.current();
            if (token.type !== 'eof') {
                const result = {
                    ok: false,
                    kind: 'trailing-input',
                    reason: 'trailing-input',
                    index: token.start
                };
                return canUseCache ? cacheParsedExpressionResult(cacheKey, result) : result;
            }
            const result = options.buildAst === true
                ? { ok: true, kind: 'expression', ast }
                : { ok: true, kind: 'expression' };
            return canUseCache ? cacheParsedExpressionResult(cacheKey, result) : result;
        } catch (error) {
            const result = {
                ok: false,
                kind: 'invalid-expression',
                reason: error.reason || 'invalid-expression',
                index: error.index ?? 0
            };
            return canUseCache ? cacheParsedExpressionResult(cacheKey, result) : result;
        }
    }

    function getNodeSource(source, ast) {
        if (!ast || !Number.isInteger(ast.start) || !Number.isInteger(ast.end)) return '';
        return String(source || '').trim().slice(ast.start, ast.end).trim();
    }

    function getRootNamedArgumentExpression(source, options = {}) {
        const text = String(source || '').trim();
        if (!text || text[0] !== '.') return null;
        const tokens = tokenizePawnExpression(text, options);
        if (tokens[0]?.value !== '.' || tokens[1]?.type !== 'identifier' || tokens[2]?.value !== '=') return null;
        const exprText = text.slice(tokens[3]?.start ?? text.length).trim();
        if (!exprText) return null;
        const parsed = parsePawnExpression(exprText, options);
        if (!parsed.ok) return null;
        return {
            name: tokens[1].value,
            expression: exprText,
            expressionStart: tokens[3]?.start ?? text.length
        };
    }

    function isNamedArgumentTarget(source, options = {}) {
        const text = String(source || '').trim();
        if (!text || text[0] !== '.') return false;
        const tokens = tokenizePawnExpression(text, options);
        return tokens.length === 3 &&
            tokens[0]?.value === '.' &&
            tokens[1]?.type === 'identifier' &&
            tokens[2]?.type === 'eof';
    }

    function getRootTagCastExpression(source, options = {}) {
        const text = String(source || '').trim();
        if (!text || !text.includes(':')) return null;
        const parsed = parsePawnExpression(text, { ...options, buildAst: true });
        if (!parsed.ok || parsed.ast?.kind !== 'tag-cast') return null;
        return {
            tag: parsed.ast.tag,
            expression: getNodeSource(text, parsed.ast.expr)
        };
    }

    function stripRootTagCasts(source, options = {}) {
        let text = String(source || '').trim();
        if (!text || (text[0] !== '.' && text[0] !== '(' && !text.includes(':'))) return text;
        let changed = false;
        for (let guard = 0; guard < 16; guard++) {
            const named = getRootNamedArgumentExpression(text, options);
            if (named) {
                text = named.expression;
                changed = true;
                continue;
            }
            const parsed = parsePawnExpression(text, { ...options, buildAst: true });
            if (!parsed.ok) break;
            if (parsed.ast?.kind === 'group') {
                const next = getNodeSource(text, parsed.ast.expr);
                if (!next || next === text) break;
                text = next;
                changed = true;
                continue;
            }
            if (parsed.ast?.kind === 'tag-cast') {
                const next = getNodeSource(text, parsed.ast.expr);
                if (!next || next === text) break;
                text = next;
                changed = true;
                continue;
            }
            break;
        }
        return changed ? text : String(source || '').trim();
    }

    function isAssignableExpressionAst(ast) {
        if (!ast) return false;
        if (ast.kind === 'group' || ast.kind === 'tag-cast') return isAssignableExpressionAst(ast.expr);
        if (ast.kind === 'identifier') return true;
        if (ast.kind === 'index') return isAssignableExpressionAst(ast.expr);
        return false;
    }

    function isSyntacticAssignableExpression(source, options = {}) {
        const text = stripRootTagCasts(source, options);
        if (!text) return false;
        const named = getRootNamedArgumentExpression(text, options);
        if (named && !named.expression) return true;
        const parsed = parsePawnExpression(text, { ...options, buildAst: true, allowAssignment: false });
        return parsed.ok && isAssignableExpressionAst(parsed.ast);
    }

    function unwrapSemanticRoot(ast) {
        let node = ast;
        while (node?.kind === 'group' || node?.kind === 'tag-cast') node = node.expr;
        return node || null;
    }

    function findBalancedIndexedAccessEnd(source, openIndex, options = {}) {
        const text = String(source || '');
        const open = text[openIndex];
        const close = open === '[' ? ']' : open === '{' ? '}' : '';
        if (!close) return -1;
        const escapeChar = options.escapeChar || '';
        let depth = 0;
        let inString = false;
        let stringChar = '';
        for (let index = openIndex; index < text.length; index++) {
            const char = text[index];
            if (inString) {
                if (char === stringChar && !isQuoteEscaped(text, index, escapeChar)) {
                    inString = false;
                }
                continue;
            }
            if (char === '"' || char === '\'') {
                inString = true;
                stringChar = char;
                continue;
            }
            if (char === open) {
                depth++;
                continue;
            }
            if (char === close) {
                depth--;
                if (depth === 0) return index;
            }
        }
        return -1;
    }

    function parseBalancedIndexedAccessExpression(source, options = {}) {
        const text = String(source || '').trim();
        if (!text) return null;
        let cursor = 0;
        const skipSpaces = () => {
            while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
        };
        skipSpaces();

        for (let guard = 0; guard < 8; guard++) {
            const tag = readIdentifierAt(text, cursor);
            if (!tag) break;
            let next = tag.end;
            while (next < text.length && /\s/.test(text[next])) next++;
            if (text[next] !== ':' || FORBIDDEN_TAG_CASTS.has(tag.value)) break;
            cursor = next + 1;
            skipSpaces();
        }

        const base = readIdentifierAt(text, cursor);
        if (!base) return null;
        cursor = base.end;
        const accesses = [];
        for (;;) {
            skipSpaces();
            if (cursor >= text.length) break;
            const open = text[cursor];
            if (open !== '[' && open !== '{') return null;
            const end = findBalancedIndexedAccessEnd(text, cursor, options);
            if (end < 0) return null;
            const accessText = text.slice(cursor, end + 1);
            if (!options.allowEmptyIndexAccesses && !accessText.slice(1, -1).trim()) return null;
            accesses.push(accessText);
            cursor = end + 1;
        }
        if (!accesses.length) return null;
        return {
            baseName: base.value,
            accesses
        };
    }

    function parseIndexedAccessExpression(source, options = {}) {
        const text = String(source || '').trim();
        const trailingEmptyAccesses = [];
        let parseText = text;
        if (options.allowEmptyIndexAccesses) {
            for (;;) {
                const match = parseText.match(/\[\s*\]\s*$/);
                if (!match) break;
                trailingEmptyAccesses.unshift(parseText.slice(match.index).trim());
                parseText = parseText.slice(0, match.index).trimEnd();
            }
        }
        if (!parseText || (parseText.indexOf('[') < 0 && parseText.indexOf('{') < 0 && !trailingEmptyAccesses.length)) return null;
        const parsed = parsePawnExpression(parseText, { ...options, buildAst: true, allowAssignment: false });
        if (!parsed.ok) {
            if (trailingEmptyAccesses.length) return null;
            return parseBalancedIndexedAccessExpression(text, options);
        }

        const accesses = [];
        let node = unwrapSemanticRoot(parsed.ast);
        while (node?.kind === 'index') {
            const innerText = getNodeSource(parseText, node.index);
            if (!innerText) return null;
            const accessText = node.access === '{}'
                ? `{${innerText}}`
                : `[${innerText}]`;
            accesses.unshift(accessText);
            node = unwrapSemanticRoot(node.expr);
        }
        if (node?.kind !== 'identifier' || (!accesses.length && !trailingEmptyAccesses.length)) return null;
        return {
            baseName: node.name,
            accesses: trailingEmptyAccesses.length
                ? [...accesses, ...trailingEmptyAccesses]
                : accesses
        };
    }

    function parseWholeCallExpression(source, options = {}) {
        const text = String(source || '').trim();
        if (!text || text.indexOf('(') < 0) return null;
        const parsed = parsePawnExpression(text, {
            ...options,
            buildAst: true,
            allowAssignment: options.allowAssignment !== false
        });
        if (!parsed.ok) return null;
        const node = unwrapSemanticRoot(parsed.ast);
        const callee = unwrapSemanticRoot(node?.callee);
        if (node?.kind !== 'call' || callee?.kind !== 'identifier') return null;
        const openIndex = node.openToken?.start ?? -1;
        const closeIndex = node.closeToken?.start ?? -1;
        if (openIndex < 0 || closeIndex < openIndex) return null;
        return {
            name: callee.name,
            openIndex,
            closeIndex,
            argsText: text.slice(openIndex + 1, closeIndex),
            args: node.args.map(arg => getNodeSource(text, arg))
        };
    }

    function parseBraceArrayLiteralExpression(source, options = {}) {
        const text = String(source || '').trim();
        if (!text || text.indexOf('{') < 0) return null;
        if (!isWholeDelimitedSource(text, '{', '}', options)) return null;
        const inner = text.slice(1, -1);
        const parts = splitTopLevelDelimitedItems(inner, { ...options, keepEmpty: true });
        for (const part of parts) {
            if (!part) return null;
            const parsed = parsePawnExpression(part, { ...options, allowAssignment: false });
            if (!parsed.ok) return null;
        }
        return parts;
    }

    function flattenRootBinaryExpression(source, options = {}) {
        const text = String(source || '').trim();
        if (!/[+\-*/%&|^<>=]/.test(text)) return null;
        const parsed = parsePawnExpression(text, { ...options, buildAst: true, allowAssignment: false });
        if (!parsed.ok || parsed.ast?.kind !== 'binary') return null;
        const parts = [];
        const operators = [];
        const visit = ast => {
            if (ast?.kind === 'binary') {
                visit(ast.left);
                operators.push(ast.operator);
                visit(ast.right);
                return;
            }
            const part = getNodeSource(text, ast);
            if (part) parts.push(part);
        };
        visit(parsed.ast);
        return parts.length >= 2 ? { parts, operators } : null;
    }

    function findTopLevelTernaryParts(source, options = {}) {
        const text = String(source || '');
        const escapeChar = options.escapeChar || '^';
        let questionIndex = -1;
        let nestedTernaryDepth = 0;
        const groupStack = [];
        let inString = false;
        let stringChar = '';

        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inString) {
                if (char === stringChar && !isQuoteEscaped(text, index, escapeChar)) {
                    inString = false;
                }
                continue;
            }
            if (char === '"' || char === '\'') {
                inString = true;
                stringChar = char;
                continue;
            }
            if (char === '(' || char === '[' || char === '{') {
                groupStack.push(char);
                continue;
            }
            if (char === ')' || char === ']' || char === '}') {
                const expected = char === ')' ? '(' : char === ']' ? '[' : '{';
                if (groupStack[groupStack.length - 1] === expected) groupStack.pop();
                continue;
            }
            if (groupStack.length) continue;
            if (char === '?') {
                if (questionIndex < 0) {
                    questionIndex = index;
                } else {
                    nestedTernaryDepth++;
                }
                continue;
            }
            if (char === ':' && questionIndex >= 0) {
                if (nestedTernaryDepth > 0) {
                    nestedTernaryDepth--;
                    continue;
                }
                const condition = text.slice(0, questionIndex).trim();
                const whenTrue = text.slice(questionIndex + 1, index).trim();
                const whenFalse = text.slice(index + 1).trim();
                return condition && whenTrue && whenFalse
                    ? { condition, whenTrue, whenFalse }
                    : null;
            }
        }
        return null;
    }

    function parseTopLevelTernaryExpression(source, options = {}) {
        const text = String(source || '').trim();
        if (!text.includes('?')) return null;
        const parsed = parsePawnExpression(text, { ...options, buildAst: true, allowAssignment: false });
        const ast = unwrapSemanticRoot(parsed.ast);
        if (!parsed.ok || ast?.kind !== 'ternary') {
            return findTopLevelTernaryParts(text, options);
        }
        return {
            condition: getNodeSource(text, ast.condition),
            whenTrue: getNodeSource(text, ast.whenTrue),
            whenFalse: getNodeSource(text, ast.whenFalse)
        };
    }

    function classifyPawnExpressionFragment(source, options = {}) {
        return parsePawnExpression(source, options);
    }

    const looksLikePawnExpressionFragment = (source, options = {}) =>
        parsePawnExpression(source, options).ok;

    return {
        tokenizePawnExpression,
        parsePawnExpression,
        getNodeSource,
        getRootNamedArgumentExpression,
        isNamedArgumentTarget,
        getRootTagCastExpression,
        stripRootTagCasts,
        isSyntacticAssignableExpression,
        parseIndexedAccessExpression,
        parseWholeCallExpression,
        parseBraceArrayLiteralExpression,
        flattenRootBinaryExpression,
        parseTopLevelTernaryExpression,
        classifyPawnExpressionFragment,
        looksLikePawnExpressionFragment
    };
}

module.exports = { createSemanticSyntaxCore };
