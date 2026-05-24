const { findBalancedGroupEnd } = require('./balanced');
const {
    findTopLevelSimpleAssignmentOperator: findTopLevelSimpleAssignmentOperatorCore
} = require('./top-level');
const { PRAGMA_DIRECTIVE_NAMES } = require('./preprocessor-directive-names');
const { hasDeclModifier } = require('../declarations/modifiers');

function createWarningPolicySyntaxCore() {
    const COMPILER_SYMBOL_MAX_LENGTH = 63;
    const KNOWN_PRAGMA_NAMES = new Set(PRAGMA_DIRECTIVE_NAMES);

    const createWarningIssue = (kind, messageKey, params = {}) => ({
        kind,
        messageKey,
        params,
        severity: 'warning'
    });

    function findTopLevelSimpleAssignmentOperator(source) {
        return findTopLevelSimpleAssignmentOperatorCore(source);
    }

    function findPossiblyUnintendedAssignmentInCondition(source, keywordStart, keyword) {
        const text = String(source || '');
        if (keyword !== 'if' && keyword !== 'while') return null;
        let index = Math.max(0, keywordStart + keyword.length);
        while (index < text.length && /\s/.test(text[index])) index++;
        if (text[index] !== '(') return null;
        const openIndex = index;
        const closeIndex = findBalancedGroupEnd(text, openIndex, '(', ')');
        if (closeIndex <= openIndex) return null;
        const condition = text.slice(openIndex + 1, closeIndex);
        const operatorIndex = findTopLevelSimpleAssignmentOperator(condition);
        if (operatorIndex < 0) return null;
        return {
            kind: 'possiblyUnintendedAssignment',
            messageKey: 'validation.possiblyUnintendedAssignment',
            severity: 'warning',
            start: openIndex + 1 + operatorIndex,
            end: openIndex + 2 + operatorIndex
        };
    }

    function getRedundantSizeofDefaultIssue(defaultOperator, referencedParamMeta) {
        if (!defaultOperator || defaultOperator.operator !== 'sizeof') return null;
        if (!referencedParamMeta) return null;
        if (String(referencedParamMeta.expectedDims || '').trim()) return null;
        return createWarningIssue('redundantSizeof', 'validation.redundantSizeof', {
            name: defaultOperator.symbolName || referencedParamMeta.name || ''
        });
    }

    function getFunctionShouldReturnValueIssue(functionDecl, returnState, terminalState) {
        if (!functionDecl?.name) return null;
        if (!returnState?.sawValue) return null;
        if (terminalState?.hasFunctionLevelTerminal) return null;
        return createWarningIssue('functionShouldReturnValue', 'validation.functionShouldReturnValue', {
            name: functionDecl.name
        });
    }

    function getSymbolTruncationIssue(name) {
        const text = String(name || '');
        if (text.length <= COMPILER_SYMBOL_MAX_LENGTH) return null;
        return createWarningIssue('symbolTruncated', 'validation.symbolTruncated', {
            name: text.slice(0, COMPILER_SYMBOL_MAX_LENGTH),
            max: COMPILER_SYMBOL_MAX_LENGTH
        });
    }

    function normalizeDefineForComparison(defineDecl) {
        return [
            String(defineDecl?.name || ''),
            String(defineDecl?.args || '').replace(/\s+/g, ' ').trim(),
            String(defineDecl?.macroStyle || ''),
            String(defineDecl?.macroIndexer || '').replace(/\s+/g, ' ').trim(),
            String(defineDecl?.value || '').replace(/\s+/g, ' ').trim()
        ].join('\u0000');
    }

    function getMacroRedefinitionIssue(previousDefine, nextDefine) {
        if (!previousDefine?.name || !nextDefine?.name) return null;
        if (previousDefine.name !== nextDefine.name) return null;
        if (normalizeDefineForComparison(previousDefine) === normalizeDefineForComparison(nextDefine)) return null;
        return createWarningIssue('macroRedefinition', 'validation.macroRedefinition', {
            name: nextDefine.name
        });
    }

    function isScalarConstantDecl(decl) {
        return !!(
            decl?.type === 'variable' &&
            hasDeclModifier(decl, 'const') &&
            !String(decl.dims || '').trim()
        );
    }

    function normalizeConstantValueForComparison(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function getConstantComparisonValue(decl, evaluateConstantValue) {
        const source = String(decl?.value || '').trim();
        if (!source) return { known: true, value: 0 };
        const evaluated = evaluateConstantValue(source);
        if (evaluated != null) return { known: true, value: Number(evaluated) };
        return { known: false, value: normalizeConstantValueForComparison(source) };
    }

    function getConstantRedefinitionIssue(previousDecl, nextDecl, options = {}) {
        if (!previousDecl?.name || !nextDecl?.name) return null;
        if (previousDecl.name !== nextDecl.name) return null;
        if (!isScalarConstantDecl(previousDecl) || !isScalarConstantDecl(nextDecl)) return null;
        const previousValue = getConstantComparisonValue(previousDecl, options.evaluateConstantValue);
        const nextValue = getConstantComparisonValue(nextDecl, options.evaluateConstantValue);
        if (previousValue.known === nextValue.known && previousValue.value === nextValue.value) {
            return {
                kind: 'constantRedefinition',
                severity: 'silent'
            };
        }
        return createWarningIssue('constantRedefinition', 'validation.constantRedefinition', {
            name: nextDecl.name
        });
    }

    function getUnknownPragmaIssue(name) {
        const pragmaName = String(name || '').trim().toLowerCase();
        if (pragmaName && KNOWN_PRAGMA_NAMES.has(pragmaName)) return null;
        return createWarningIssue('unknownPragma', 'validation.unknownPragma', {
            name: pragmaName || '#pragma'
        });
    }

    function getNestedCommentIssue() {
        return createWarningIssue('nestedComment', 'validation.nestedComment');
    }

    function getConstantControlTestIssue(value) {
        if (value == null) return null;
        return Number(value) === 0
            ? createWarningIssue('redundantCodeNeverExecuted', 'validation.redundantCodeNeverExecuted')
            : createWarningIssue('redundantTestAlwaysNonZero', 'validation.redundantTestAlwaysNonZero');
    }

    function getStatementHasNoEffectIssue(noEffectIssue) {
        if (!noEffectIssue) return null;
        return createWarningIssue('statementHasNoEffect', 'validation.statementHasNoEffect');
    }

    function getUnreachableCodeIssue() {
        return createWarningIssue('unreachableCode', 'validation.unreachableCode');
    }

    function getSelfAssignmentIssue(assignable, lhs) {
        return createWarningIssue('selfAssignment', 'validation.selfAssignment', {
            name: assignable?.name || String(lhs || '').trim()
        });
    }

    function getLabelNameShadowsTagIssue(name) {
        const labelName = String(name || '').trim();
        if (!labelName) return null;
        return createWarningIssue('labelNameShadowsTagname', 'validation.labelNameShadowsTagname', {
            name: labelName
        });
    }

    function getVariableShadowingIssue(decl, shadowedDecl, options = {}) {
        const name = String(decl?.name || '').trim();
        if (!name || !shadowedDecl || shadowedDecl === decl) return null;
        if (options.declarationKind === 'local') return null;
        return createWarningIssue('symbolShadows', 'validation.symbolShadows', { name });
    }

    function getOldStylePrototypeIssue(functionDecl, headerText) {
        if (!functionDecl?.name) return null;
        if (functionDecl.type === 'native' || functionDecl.type === 'forward' || functionDecl.type === 'define') {
            return null;
        }
        const source = String(headerText || '').trim();
        if (!source.endsWith(';')) return null;
        return createWarningIssue('oldStylePrototype', 'validation.oldStylePrototype');
    }

    function getNoImplementationForStateIssue(state, name) {
        return createWarningIssue('noImplementationForState', 'validation.noImplementationForState', {
            state: String(state || ''),
            name: String(name || '')
        });
    }

    function getSymbolNeverUsedIssue(name) {
        return createWarningIssue('symbolNeverUsed', 'validation.symbolNeverUsed', {
            name: String(name || '')
        });
    }

    function getSymbolAssignedValueNeverUsedIssue(name) {
        return createWarningIssue('symbolAssignedValueNeverUsed', 'validation.symbolAssignedValueNeverUsed', {
            name: String(name || '')
        });
    }

    return {
        COMPILER_SYMBOL_MAX_LENGTH,
        findTopLevelSimpleAssignmentOperator,
        findPossiblyUnintendedAssignmentInCondition,
        getRedundantSizeofDefaultIssue,
        getFunctionShouldReturnValueIssue,
        getSymbolTruncationIssue,
        getMacroRedefinitionIssue,
        getConstantRedefinitionIssue,
        getUnknownPragmaIssue,
        getNestedCommentIssue,
        getConstantControlTestIssue,
        getStatementHasNoEffectIssue,
        getUnreachableCodeIssue,
        getSelfAssignmentIssue,
        getLabelNameShadowsTagIssue,
        getVariableShadowingIssue,
        getOldStylePrototypeIssue,
        getNoImplementationForStateIssue,
        getSymbolNeverUsedIssue,
        getSymbolAssignedValueNeverUsedIssue
    };
}

module.exports = { createWarningPolicySyntaxCore };
