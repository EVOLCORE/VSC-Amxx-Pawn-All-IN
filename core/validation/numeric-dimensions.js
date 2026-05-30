const {
    PAWN_IDENTIFIER_SOURCE,
    containsPawnIdentifierStartChar
} = require('../syntax/identifiers');
const { createDimensionSyntaxCore } = require('../syntax/dimensions');
const { hasDeclModifier } = require('../declarations/modifiers');

const SIZEOF_IDENTIFIER_RE = new RegExp(`\\bsizeof\\s*\\(\\s*(${PAWN_IDENTIFIER_SOURCE})((?:\\s*\\[\\s*\\])*)\\s*\\)`, 'g');
const PAWN_IDENTIFIER_WORD_RE = new RegExp(`\\b(${PAWN_IDENTIFIER_SOURCE})\\b`, 'g');

function createNumericDimensionValidationCore(deps) {
    const {
        evaluatePawnCharacterLiteralValue,
        extractEnumSymbolName,
        findAnyDeclByNameFromSources,
        FORBIDDEN,
        getActiveCtrlChar,
        getEffectiveDeclDimParts,
        getEnumDeclResolvedCapacity,
        macroExpansionCore,
        replaceNumericCharacterLiteralsForValidation,
        semanticSyntaxCore
    } = deps;

    const parsedNumericExprCache = new Map();
    const PARSED_NUMERIC_EXPR_CACHE_LIMIT = 4096;
    const PARSED_NUMERIC_EXPR_CACHE_MAX_CHARS = 512;
    const PAWN_CHARS_PER_CELL = 4;
    const EMPTY_SEEN_NAMES = new Set();
    const SIMPLE_NUMERIC_LITERAL_RE = /^[+-]?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)$/;
    const dimensionSyntaxCore = createDimensionSyntaxCore();
    const parseDimsParts = dimensionSyntaxCore.parseDimsParts;

    function evaluateSimpleNumericLiteral(source) {
        const text = String(source || '').trim();
        if (!SIMPLE_NUMERIC_LITERAL_RE.test(text)) return null;
        if (/^[+-]?0[xX]/.test(text)) {
            const sign = text.charCodeAt(0) === 45 ? -1 : 1;
            const start = text.charCodeAt(0) === 43 || text.charCodeAt(0) === 45 ? 1 : 0;
            const value = Number.parseInt(text.slice(start), 16);
            return Number.isFinite(value) ? sign * value : null;
        }
        const value = Number(text);
        return Number.isFinite(value) ? value : null;
    }

    function evaluateParsedPawnNumericExpr(source) {
        const input = String(source || '');
        if (input.length <= PARSED_NUMERIC_EXPR_CACHE_MAX_CHARS && parsedNumericExprCache.has(input)) {
            const cached = parsedNumericExprCache.get(input);
            parsedNumericExprCache.delete(input);
            parsedNumericExprCache.set(input, cached);
            return cached;
        }
        const cacheParsedNumericExprResult = result => {
            if (input.length <= PARSED_NUMERIC_EXPR_CACHE_MAX_CHARS) {
                parsedNumericExprCache.set(input, result);
                while (parsedNumericExprCache.size > PARSED_NUMERIC_EXPR_CACHE_LIMIT) {
                    parsedNumericExprCache.delete(parsedNumericExprCache.keys().next().value);
                }
            }
            return result;
        };
        const parsed = semanticSyntaxCore.parsePawnExpression(input, {
            escapeChar: getActiveCtrlChar(),
            buildAst: true,
            allowAssignment: false
        });
        if (!parsed.ok) return cacheParsedNumericExprResult(null);

        const evaluateAst = ast => {
            if (!ast) return null;
            if (ast.kind === 'group' || ast.kind === 'tag-cast') return evaluateAst(ast.expr);
            if (ast.kind === 'number') {
                const raw = String(ast.value || '');
                const value = /^0[xX]/.test(raw)
                    ? Number.parseInt(raw, 16)
                    : Number(raw);
                return Number.isFinite(value) ? value : null;
            }
            if (ast.kind === 'char') {
                return evaluatePawnCharacterLiteralValue(ast.value, getActiveCtrlChar());
            }
            if (ast.kind === 'identifier') {
                if (ast.name === 'true') return 1;
                if (ast.name === 'false') return 0;
                if (ast.name === 'cellmin') return -2147483648;
                if (ast.name === 'cellmax') return 2147483647;
                return null;
            }
            if (ast.kind === 'unary') {
                const value = evaluateAst(ast.expr);
                if (value == null) return null;
                if (ast.operator === '+') return +value;
                if (ast.operator === '-') return -value;
                if (ast.operator === '~') return ~value;
                if (ast.operator === '!') return value ? 0 : 1;
                if (ast.operator === 'char') return Math.max(0, Math.ceil(value / PAWN_CHARS_PER_CELL));
                return null;
            }
            if (ast.kind === 'postfix') {
                const value = evaluateAst(ast.expr);
                if (value == null) return null;
                if (ast.operator === 'char') return Math.max(0, Math.ceil(value / PAWN_CHARS_PER_CELL));
                return null;
            }
            if (ast.kind === 'binary') {
                const left = evaluateAst(ast.left);
                const right = evaluateAst(ast.right);
                if (left == null || right == null) return null;
                if (ast.operator === '+') return left + right;
                if (ast.operator === '-') return left - right;
                if (ast.operator === '*') return left * right;
                if (ast.operator === '/') return left / right;
                if (ast.operator === '%') return left % right;
                if (ast.operator === '<<') return left << right;
                if (ast.operator === '>>') return left >> right;
                if (ast.operator === '<') return left < right ? 1 : 0;
                if (ast.operator === '<=') return left <= right ? 1 : 0;
                if (ast.operator === '>') return left > right ? 1 : 0;
                if (ast.operator === '>=') return left >= right ? 1 : 0;
                if (ast.operator === '==') return left === right ? 1 : 0;
                if (ast.operator === '!=') return left !== right ? 1 : 0;
                if (ast.operator === '&') return left & right;
                if (ast.operator === '^') return left ^ right;
                if (ast.operator === '|') return left | right;
                if (ast.operator === '&&') return left && right ? 1 : 0;
                if (ast.operator === '||') return left || right ? 1 : 0;
                return null;
            }
            if (ast.kind === 'ternary') {
                const condition = evaluateAst(ast.condition);
                if (condition == null) return null;
                return evaluateAst(condition ? ast.whenTrue : ast.whenFalse);
            }
            return null;
        };

        const result = evaluateAst(parsed.ast);
        return cacheParsedNumericExprResult(Number.isFinite(result) ? result : null);
    }

    function evaluatePawnNumericExpr(expr, decls = [], seen = null, analysisCache = null) {
        const cacheKey = String(expr || '').trim();
        let localSeen = seen instanceof Set ? seen : null;
        const isTopLevelSeen = !localSeen || localSeen.size === 0;
        const canUseCache = !!(analysisCache?.numericExprByText && isTopLevelSeen);
        if (canUseCache && analysisCache.numericExprByText.has(cacheKey)) {
            return analysisCache.numericExprByText.get(cacheKey);
        }
        const cacheNumericExprResult = result => {
            if (canUseCache) {
                analysisCache.numericExprByText.set(cacheKey, result);
            }
            return result;
        };

        if (!cacheKey) return cacheNumericExprResult(null);
        const simpleLiteral = evaluateSimpleNumericLiteral(cacheKey);
        if (simpleLiteral != null) return cacheNumericExprResult(simpleLiteral);
        if (!containsPawnIdentifierStartChar(cacheKey)) {
            return cacheNumericExprResult(evaluateParsedPawnNumericExpr(cacheKey));
        }

        const hasSeenName = name => !!(localSeen && localSeen.has(name));
        const getMutableSeen = () => {
            if (!localSeen) localSeen = new Set();
            return localSeen;
        };
        let source = semanticSyntaxCore.stripRootTagCasts(expr, { escapeChar: getActiveCtrlChar() });
        if (!source) return cacheNumericExprResult(null);
        const expanded = macroExpansionCore.expandMacros(source, decls, {
            escapeChar: getActiveCtrlChar(),
            disabledNames: localSeen || EMPTY_SEEN_NAMES,
            getDefine: name => analysisCache?.findDefineByName
                ? analysisCache.findDefineByName(name)
                : findAnyDeclByNameFromSources(
                    decls,
                    name,
                    item => item.type === 'define',
                    analysisCache
                ),
            maxOutputLength: 8192
        });
        if (!expanded.complete) return cacheNumericExprResult(null);
        source = expanded.text;

        if (containsPawnIdentifierStartChar(source)) {
            source = source.replace(SIZEOF_IDENTIFIER_RE, (_, name, emptyAccesses) => {
                const decl = findAnyDeclByNameFromSources(decls, name, null, analysisCache);
                if (!decl) return 'NaN';
                if (decl.type === 'enum' && /^-?\d+$/.test(String(decl.value || ''))) {
                    return String(decl.value);
                }
                if (decl.dims) {
                    const effectiveDimParts = typeof getEffectiveDeclDimParts === 'function'
                        ? getEffectiveDeclDimParts(decl)
                        : parseDimsParts(decl.dims);
                    const level = (String(emptyAccesses || '').match(/\[/g) || []).length;
                    const dimPart = effectiveDimParts[level];
                    const dimSpec = parseDimSpec(dimPart, decls, getMutableSeen(), analysisCache);
                    return dimSpec.capacity != null ? String(dimSpec.capacity) : 'NaN';
                }
                return 'NaN';
            });

            source = source.replace(PAWN_IDENTIFIER_WORD_RE, (full, name) => {
                if (FORBIDDEN.has(name)) return full;
                if (hasSeenName(name)) return 'NaN';

                const decl = findAnyDeclByNameFromSources(decls, name, null, analysisCache);
                if (!decl) return full;

                if (decl.type === 'enum' && /^-?\d+$/.test(String(decl.value || ''))) {
                    return String(decl.value);
                }
                if (decl.type === 'enum-item' && /^-?\d+$/.test(String(decl.value || ''))) {
                    return String(decl.value);
                }
                if (decl.type === 'define') {
                    const defineValue = String(decl.value || '').trim();
                    if (decl.args) return full;
                    if (/^-?\d+$/.test(defineValue)) return defineValue;
                    const mutableSeen = getMutableSeen();
                    mutableSeen.add(name);
                    const nested = evaluatePawnNumericExpr(defineValue, decls, mutableSeen, analysisCache);
                    mutableSeen.delete(name);
                    return nested == null ? 'NaN' : String(nested);
                }
                if (
                    decl.type === 'variable' &&
                    !decl.isArg &&
                    !decl.dims &&
                    hasDeclModifier(decl, 'const')
                ) {
                    const constValue = String(decl.value || '').trim();
                    if (!constValue || hasSeenName(name)) return 'NaN';
                    const mutableSeen = getMutableSeen();
                    mutableSeen.add(name);
                    const nested = evaluatePawnNumericExpr(constValue, decls, mutableSeen, analysisCache);
                    mutableSeen.delete(name);
                    return nested == null ? 'NaN' : String(nested);
                }

                return full;
            });
        }

        const validationSource = source.indexOf('\'') >= 0
            ? replaceNumericCharacterLiteralsForValidation(source, getActiveCtrlChar())
            : source;
        const sanitized = source.replace(/\s+/g, '');
        const validationForTokenGuard = validationSource.replace(/\b(?:char|cellmin|cellmax)\b/g, '');
        const validationSanitized = validationForTokenGuard.replace(/\s+/g, '');
        if (!sanitized) return cacheNumericExprResult(null);
        if (/[A-WYZa-wyz_@]/.test(validationSanitized.replace(/0[xX][0-9a-fA-F]+/g, '0'))) return cacheNumericExprResult(null);

        const withoutHex = validationSanitized.replace(/0[xX][0-9a-fA-F]+/g, '0');
        const withoutCompoundOps = withoutHex.replace(/<<|>>|<=|>=|==|!=|&&|\|\|/g, '');
        if (/[^0-9+\-*/%()|&~^<>!?:]/.test(withoutCompoundOps)) return cacheNumericExprResult(null);

        return cacheNumericExprResult(evaluateParsedPawnNumericExpr(source));
    }

    function parseDimSpec(dimPart, decls = [], seen = null, analysisCache = null) {
        let localSeen = seen instanceof Set ? seen : null;
        const getMutableSeen = () => {
            if (!localSeen) localSeen = new Set();
            return localSeen;
        };
        const raw = String(dimPart || '').trim();
        const isChar = /\bchar\b/.test(raw);
        const expr = raw.replace(/\bchar\b/g, '').trim();
        const enumCandidate = extractEnumSymbolName(dimPart);
        const enumDecl = enumCandidate
            ? (() => {
                const candidate = findAnyDeclByNameFromSources(decls, enumCandidate, null, analysisCache);
                return candidate?.type === 'enum' ? candidate : null;
            })()
            : null;
        const enumName = enumDecl ? enumCandidate : '';
        let capacity = expr ? evaluatePawnNumericExpr(expr, decls, localSeen, analysisCache) : null;
        if (enumDecl && /^[A-Za-z_@]\w*$/.test(expr || '')) {
            const mutableSeen = getMutableSeen();
            const enumRootCapacity = getEnumDeclResolvedCapacity(enumDecl, decls, mutableSeen, analysisCache) ??
                evaluatePawnNumericExpr(
                    String(enumDecl.value ?? '').trim(),
                    decls,
                    mutableSeen,
                    analysisCache
                );
            if (enumRootCapacity != null) {
                capacity = enumRootCapacity;
            } else {
                const numericMemberValues = (enumDecl.enumMembers || [])
                    .map(item => Number.parseInt(String(item?.value ?? ''), 10))
                    .filter(value => Number.isFinite(value));
                if (numericMemberValues.length) {
                    capacity = Math.max(...numericMemberValues) + 1;
                }
            }
        }
        return { raw, expr, isChar, capacity, enumName };
    }

    function isResolvedDimSpec(dimSpec) {
        if (!dimSpec) return false;
        if (!dimSpec.raw) return true;
        return dimSpec.capacity != null;
    }

    return {
        evaluatePawnNumericExpr,
        isResolvedDimSpec,
        parseDimSpec,
        parseDimsParts
    };
}

module.exports = { createNumericDimensionValidationCore };
