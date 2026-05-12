const { containsPawnIdentifierStartChar } = require('../syntax/identifiers');
const { createDimensionSyntaxCore } = require('../syntax/dimensions');

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
    const dimensionSyntaxCore = createDimensionSyntaxCore();

    function parseDimsParts(dimsStr) {
        return dimensionSyntaxCore.parseDimsParts(dimsStr);
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

    function evaluatePawnNumericExpr(expr, decls = [], seen = new Set(), analysisCache = null) {
        const cacheKey = String(expr || '').trim();
        const canUseCache = !!(analysisCache?.numericExprByText && seen?.size === 0);
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
        if (!containsPawnIdentifierStartChar(cacheKey)) {
            return cacheNumericExprResult(evaluateParsedPawnNumericExpr(cacheKey));
        }

        let source = semanticSyntaxCore.stripRootTagCasts(expr, { escapeChar: getActiveCtrlChar() });
        if (!source) return cacheNumericExprResult(null);
        const expanded = macroExpansionCore.expandMacros(source, decls, {
            escapeChar: getActiveCtrlChar(),
            disabledNames: seen,
            getDefine: name => findAnyDeclByNameFromSources(
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
            source = source.replace(/\bsizeof\s*\(\s*([A-Za-z_@]\w*)((?:\s*\[\s*\])*)\s*\)/g, (_, name, emptyAccesses) => {
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
                    const dimSpec = parseDimSpec(dimPart, decls, seen, analysisCache);
                    return dimSpec.capacity != null ? String(dimSpec.capacity) : 'NaN';
                }
                return 'NaN';
            });

            source = source.replace(/\b([A-Za-z_@][A-Za-z0-9_@]*)\b/g, (full, name) => {
                if (FORBIDDEN.has(name)) return full;
                if (seen.has(name)) return 'NaN';

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
                    seen.add(name);
                    const nested = evaluatePawnNumericExpr(defineValue, decls, seen, analysisCache);
                    seen.delete(name);
                    return nested == null ? 'NaN' : String(nested);
                }
                if (
                    decl.type === 'variable' &&
                    !decl.isArg &&
                    !decl.dims &&
                    Array.isArray(decl.modifiers) &&
                    decl.modifiers.includes('const')
                ) {
                    const constValue = String(decl.value || '').trim();
                    if (!constValue || seen.has(name)) return 'NaN';
                    seen.add(name);
                    const nested = evaluatePawnNumericExpr(constValue, decls, seen, analysisCache);
                    seen.delete(name);
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

    function parseDimSpec(dimPart, decls = [], seen = new Set(), analysisCache = null) {
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
        let capacity = expr ? evaluatePawnNumericExpr(expr, decls, seen, analysisCache) : null;
        if (enumDecl && /^[A-Za-z_@]\w*$/.test(expr || '')) {
            const enumRootCapacity = getEnumDeclResolvedCapacity(enumDecl, decls, seen, analysisCache) ??
                evaluatePawnNumericExpr(
                    String(enumDecl.value ?? '').trim(),
                    decls,
                    seen,
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
