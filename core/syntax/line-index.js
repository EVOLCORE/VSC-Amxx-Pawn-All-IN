const {
    isPawnIdentifierStartCode
} = require('./identifiers');
const {
    isAtPublicFunctionStartLine,
    isExplicitDeclarationStartLine
} = require('./declaration-start');
const {
    PAWN_LOCAL_DECLARATION_KEYWORD_RE,
    PAWN_STRUCTURAL_KEYWORD_RE,
    startsWithBlockControlKeyword,
    startsWithControlKeyword: startsWithPawnControlKeyword,
    startsWithDeclarationOrControlKeyword,
    startsWithLocalDeclarationKeyword,
    startsWithPawnKeyword
} = require('./keywords');
const { isPreprocessorDirectiveLine } = require('./preprocessor-lines');
const { getPawnLineTrimBounds } = require('./whitespace');

function stripLeadingClosedDeclarationTail(source) {
    const text = String(source || '');
    let cursor = 0;
    let consumed = false;
    while (cursor < text.length) {
        while (cursor < text.length) {
            const code = text.charCodeAt(cursor);
            if (code !== 32 && code !== 9) break;
            cursor++;
        }
        const code = text.charCodeAt(cursor);
        if (code !== 59 && code !== 125) break; // ; or }
        consumed = true;
        cursor++;
    }
    if (!consumed) return '';
    return text.slice(cursor).trimStart();
}

function isBodyDeclarationContextChangeLine(source, knownPreprocessorLine = null) {
    const trimmed = String(source || '').trimStart();
    if (!trimmed) return false;
    const isPreprocessorLine = knownPreprocessorLine === null
        ? trimmed.charCodeAt(0) === 35
        : !!knownPreprocessorLine;
    if (isPreprocessorLine) {
        return startsWithPawnKeyword(trimmed, 1, 'define') ||
            startsWithPawnKeyword(trimmed, 1, 'undef');
    }
    const startsWithControl = startsWithBlockControlKeyword(trimmed);
    const closedDeclarationTail = stripLeadingClosedDeclarationTail(trimmed);
    return startsWithLocalDeclarationKeyword(trimmed) ||
        (startsWithControl && PAWN_LOCAL_DECLARATION_KEYWORD_RE.test(trimmed)) ||
        (!!closedDeclarationTail && startsWithLocalDeclarationKeyword(closedDeclarationTail));
}

function createLineIndexCore() {
    const LINE_FLAG_HAS_COMMENT_SIG = 1 << 0;
    const LINE_FLAG_HAS_LINE_COMMENT_SIG = 1 << 1;
    const LINE_FLAG_HAS_BLOCK_COMMENT_SIG = 1 << 2;
    const LINE_FLAG_HAS_DIRECTIVE_SIG = 1 << 3;
    const LINE_FLAG_HAS_BRACE_SIG = 1 << 4;
    const LINE_FLAG_HAS_PAREN_SIG = 1 << 5;
    const LINE_FLAG_HAS_BRACKET_SIG = 1 << 6;
    const LINE_FLAG_POTENTIAL_TOP_LEVEL_CONTEXT_CHANGE = 1 << 7;
    const LINE_FLAG_POTENTIAL_BODY_CONTEXT_CHANGE = 1 << 8;
    const PUNCTUATION_ONLY_LINE_RE = /^[\[\]{}(),;:]+$/;
    const BITWISE_AND_OR_CANDIDATE_RE = /(?:^|[^&])&(?:[^&=]|$)|(?:^|[^|])\|(?:[^|=]|$)/;
    const COMPARISON_OR_LOGICAL_CANDIDATE_RE = /&&|\|\||==|!=|<=|>=|[<>]/;
    const SIZEOF_KEYWORD_RE = /\bsizeof\b/;
    const RATIONAL_LITERAL_CANDIDATE_RE = /\b\d[\d_]*\.\d/;
    const BRACE_ONLY_OPTIONAL_SEMI_RE = /^[{}]+;?$/;
    const GOTO_KEYWORD_RE = /\bgoto\b/;
    const INDEX_OR_BRACE_CHAR_RE = /[{},\[\]]/;
    const STRAY_TOKEN_ALLOWED_CONTEXT_CHAR_RE = /[=([{,:?]/;
    const DIGIT_RE = /\d/;

    function resetLineCharacterSignals(signals) {
        signals.firstSlashIndex = -1;
        signals.hasDirectiveChar = false;
        signals.hasBraceChar = false;
        signals.hasParenChar = false;
        signals.hasBracketChar = false;
        signals.hasAsciiIdentifierContent = false;
        signals.hasNonAsciiContent = false;
        signals.hasInvalidAsciiCodeCharacterCandidate = false;
        signals.hasLiteralDiagnosticCandidate = false;
        signals.hasAssignmentChar = false;
        signals.hasMutationOperator = false;
        signals.hasAmpersandOrPipeChar = false;
        signals.hasComparisonOrLogicalChar = false;
        signals.hasDigitChar = false;
        signals.hasDotChar = false;
        return signals;
    }

    function scanLineCharacterSignals(source, signals) {
        const text = String(source || '');
        resetLineCharacterSignals(signals);
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            if (code === 47 && signals.firstSlashIndex < 0) signals.firstSlashIndex = index; // /
            else if (code === 35) signals.hasDirectiveChar = true; // #
            else if (code === 123 || code === 125) signals.hasBraceChar = true; // { }
            else if (code === 40 || code === 41) signals.hasParenChar = true; // ( )
            else if (code === 91 || code === 93) signals.hasBracketChar = true; // [ ]
            else if (code === 34 || code === 39) signals.hasLiteralDiagnosticCandidate = true; // " '
            else if (code === 36 || code === 96) signals.hasInvalidAsciiCodeCharacterCandidate = true; // $ `
            else if (code === 61) signals.hasAssignmentChar = true; // =
            else if (code === 38 || code === 124) signals.hasAmpersandOrPipeChar = true; // & |
            else if (code === 33 || code === 60 || code === 62) signals.hasComparisonOrLogicalChar = true; // ! < >
            else if (code >= 48 && code <= 57) signals.hasDigitChar = true;
            else if (code === 46) signals.hasDotChar = true; // .
            else if (code > 127) signals.hasNonAsciiContent = true;
            if (!signals.hasAsciiIdentifierContent && isPawnIdentifierStartCode(code)) {
                signals.hasAsciiIdentifierContent = true;
            }
            if (
                !signals.hasMutationOperator &&
                (code === 43 || code === 45) &&
                index + 1 < text.length &&
                text.charCodeAt(index + 1) === code
            ) {
                signals.hasMutationOperator = true;
            }
        }
        return signals;
    }

    function hasPotentialAssignmentOperator(source) {
        const text = String(source || '');
        for (let index = text.indexOf('='); index >= 0; index = text.indexOf('=', index + 1)) {
            const prevCode = index > 0 ? text.charCodeAt(index - 1) : 0;
            const nextCode = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
            if (nextCode === 61) continue;
            if (prevCode === 61 || prevCode === 33 || prevCode === 60 || prevCode === 62) {
                if (!((prevCode === 60 || prevCode === 62) && index > 1 && text.charCodeAt(index - 2) === prevCode)) {
                    continue;
                }
            }
            return true;
        }
        return false;
    }

    function buildLineIndex(rawLines) {
        const sourceLines = Array.isArray(rawLines) ? rawLines : [];
        const lineCount = sourceLines.length;
        const lineFlags = new Uint16Array(lineCount);
        const commentCandidateLines = [];
        const commentRelevantLines = [];
        const commentRelevantFlags = new Uint8Array(lineCount);
        const directiveCandidateLines = [];
        const parenCandidateLines = [];
        const bracketCandidateLines = [];
        const expressionCandidateLines = [];
        const expressionCandidateLineFlags = new Uint8Array(lineCount);
        const bodyDeclarationCandidateLines = [];
        const generalDiagnosticCandidateLines = [];
        const structuralDiagnosticCandidateLines = [];
        const invalidCodeCharacterCandidateLines = [];
        const unknownSymbolCandidateLines = [];
        const declarationDiagnosticCandidateLines = [];
        const expressionOperatorCandidateLines = [];
        const strayTokenCandidateLines = [];
        const preprocessorAndLabelCandidateLines = [];
        const invalidCodeCharacterCandidateLineFlags = new Uint8Array(lineCount);
        const unknownSymbolCandidateLineFlags = new Uint8Array(lineCount);
        const declarationDiagnosticCandidateLineFlags = new Uint8Array(lineCount);
        const expressionOperatorCandidateLineFlags = new Uint8Array(lineCount);
        const strayTokenCandidateLineFlags = new Uint8Array(lineCount);
        const preprocessorAndLabelCandidateLineFlags = new Uint8Array(lineCount);
        const structuralDiagnosticCandidateLineFlags = new Uint8Array(lineCount);
        const preprocessorDirectiveLineFlags = new Uint8Array(lineCount);
        const backslashContinuationLines = new Uint8Array(lineCount);
        const braceOnlyLineFlags = new Uint8Array(lineCount);
        const charSignals = {
            firstSlashIndex: -1,
            hasDirectiveChar: false,
            hasBraceChar: false,
            hasParenChar: false,
            hasBracketChar: false,
            hasAsciiIdentifierContent: false,
            hasNonAsciiContent: false,
            hasInvalidAsciiCodeCharacterCandidate: false,
            hasLiteralDiagnosticCandidate: false,
            hasAssignmentChar: false,
            hasMutationOperator: false,
            hasAmpersandOrPipeChar: false,
            hasComparisonOrLogicalChar: false,
            hasDigitChar: false,
            hasDotChar: false
        };
        const topLevelContextChangeLines = [];
        const bodyContextChangeLines = [];
        let coarseInBlockComment = false;
        let previousNonEmptyLineHadTrailingBackslash = false;

        for (let lineNo = 0; lineNo < lineCount; lineNo++) {
            const source = String(sourceLines[lineNo] || '');
            let flags = 0;
            let isDirectiveCandidate = false;
            let isCommentRelevant = coarseInBlockComment;
            scanLineCharacterSignals(source, charSignals);
            if (previousNonEmptyLineHadTrailingBackslash) {
                backslashContinuationLines[lineNo] = 1;
            }

            const firstSlashIndex = charSignals.firstSlashIndex;
            const lineCommentIndex = firstSlashIndex >= 0 ? source.indexOf('//', firstSlashIndex) : -1;
            const blockCommentStartIndex = firstSlashIndex >= 0 ? source.indexOf('/*', firstSlashIndex) : -1;
            const blockCommentEndIndex = firstSlashIndex >= 0 ? source.indexOf('*/', Math.max(0, firstSlashIndex - 1)) : -1;
            if (lineCommentIndex >= 0) flags |= LINE_FLAG_HAS_LINE_COMMENT_SIG;
            if (blockCommentStartIndex >= 0 || blockCommentEndIndex >= 0) flags |= LINE_FLAG_HAS_BLOCK_COMMENT_SIG;
            if (flags & (LINE_FLAG_HAS_LINE_COMMENT_SIG | LINE_FLAG_HAS_BLOCK_COMMENT_SIG)) {
                flags |= LINE_FLAG_HAS_COMMENT_SIG;
                commentCandidateLines.push(lineNo);
                isCommentRelevant = true;
            }
            if (charSignals.hasDirectiveChar) flags |= LINE_FLAG_HAS_DIRECTIVE_SIG;
            if (charSignals.hasBraceChar) flags |= LINE_FLAG_HAS_BRACE_SIG;
            let hasExpressionCandidate = false;
            if (charSignals.hasParenChar) {
                flags |= LINE_FLAG_HAS_PAREN_SIG;
                parenCandidateLines.push(lineNo);
                hasExpressionCandidate = true;
            }
            if (charSignals.hasBracketChar) {
                flags |= LINE_FLAG_HAS_BRACKET_SIG;
                bracketCandidateLines.push(lineNo);
                hasExpressionCandidate = true;
            }
            if (hasExpressionCandidate) {
                expressionCandidateLineFlags[lineNo] = 1;
                expressionCandidateLines.push(lineNo);
            }

            const { start, end } = getPawnLineTrimBounds(source);
            if (start < end) {
                previousNonEmptyLineHadTrailingBackslash = source.charCodeAt(end - 1) === 92;
                let isBraceOnlyLine = true;
                for (let index = start; index < end; index++) {
                    const code = source.charCodeAt(index);
                    if (code !== 123 && code !== 125) {
                        isBraceOnlyLine = false;
                        break;
                    }
                }
                if (isBraceOnlyLine) {
                    braceOnlyLineFlags[lineNo] = 1;
                }
            }

            const trimmed = (lineCommentIndex >= 0 ? source.slice(start, lineCommentIndex) : source.slice(start)).trim();
            if (trimmed) {
                const isPreprocessorLine = trimmed.charCodeAt(0) === 35;
                let isTopLevelCandidate = false;
                let isBodyCandidate = false;
                let isBodyDeclarationCandidate = false;
                let startsWithControlKeyword = false;

                if (isPreprocessorLine) {
                    preprocessorDirectiveLineFlags[lineNo] = 1;
                    isTopLevelCandidate = (
                        startsWithPawnKeyword(trimmed, 1, 'define') ||
                        startsWithPawnKeyword(trimmed, 1, 'undef')
                    );
                    isBodyCandidate = isTopLevelCandidate;
                    isBodyDeclarationCandidate = isTopLevelCandidate;
                    if (isTopLevelCandidate) {
                        flags |= LINE_FLAG_HAS_DIRECTIVE_SIG;
                        isDirectiveCandidate = true;
                    }
                } else {
                    const closedDeclarationTail = stripLeadingClosedDeclarationTail(trimmed);
                    isTopLevelCandidate = isExplicitDeclarationStartLine(trimmed) ||
                        (!!closedDeclarationTail && isExplicitDeclarationStartLine(closedDeclarationTail));
                    startsWithControlKeyword = startsWithPawnControlKeyword(trimmed);
                    isBodyCandidate = isTopLevelCandidate || startsWithControlKeyword;
                    isBodyDeclarationCandidate = startsWithLocalDeclarationKeyword(trimmed) ||
                        (startsWithControlKeyword && PAWN_LOCAL_DECLARATION_KEYWORD_RE.test(trimmed)) ||
                        (!!closedDeclarationTail && startsWithLocalDeclarationKeyword(closedDeclarationTail));
                }

                if ((flags & LINE_FLAG_HAS_DIRECTIVE_SIG) && !isDirectiveCandidate) {
                    isDirectiveCandidate = true;
                }
                if (isDirectiveCandidate) {
                    directiveCandidateLines.push(lineNo);
                }
                if (isTopLevelCandidate) {
                    flags |= LINE_FLAG_POTENTIAL_TOP_LEVEL_CONTEXT_CHANGE;
                    topLevelContextChangeLines.push(lineNo);
                }
                if (isBodyCandidate) {
                    flags |= LINE_FLAG_POTENTIAL_BODY_CONTEXT_CHANGE;
                    bodyContextChangeLines.push(lineNo);
                }
                if (isBodyDeclarationCandidate || (flags & LINE_FLAG_HAS_BLOCK_COMMENT_SIG)) {
                    bodyDeclarationCandidateLines.push(lineNo);
                }
                const hasAsciiIdentifierContent = charSignals.hasAsciiIdentifierContent;
                const hasNonAsciiContent = charSignals.hasNonAsciiContent;
                const hasInvalidAsciiCodeCharacterCandidate = charSignals.hasInvalidAsciiCodeCharacterCandidate;
                const hasLineTooLongCandidate = source.length > 4095;
                const hasLiteralDiagnosticCandidate = charSignals.hasLiteralDiagnosticCandidate;
                const hasIdentifierContent = hasAsciiIdentifierContent || hasNonAsciiContent;
                const isPunctuationOnlyLine = PUNCTUATION_ONLY_LINE_RE.test(trimmed);
                const hasAssignmentChar = charSignals.hasAssignmentChar;
                const hasPotentialAssignment = hasAssignmentChar && hasPotentialAssignmentOperator(source);
                const hasMutationOperator = charSignals.hasMutationOperator;
                const mayStartDeclarationValidation =
                    startsWithLocalDeclarationKeyword(trimmed) ||
                    (startsWithControlKeyword && PAWN_LOCAL_DECLARATION_KEYWORD_RE.test(trimmed));
                if (hasIdentifierContent || hasAssignmentChar || !isPunctuationOnlyLine) {
                    generalDiagnosticCandidateLines.push(lineNo);
                }
                if (
                    hasNonAsciiContent ||
                    hasInvalidAsciiCodeCharacterCandidate ||
                    hasLineTooLongCandidate ||
                    hasLiteralDiagnosticCandidate
                ) {
                    invalidCodeCharacterCandidateLineFlags[lineNo] = 1;
                    invalidCodeCharacterCandidateLines.push(lineNo);
                }
                if (hasAsciiIdentifierContent) {
                    unknownSymbolCandidateLineFlags[lineNo] = 1;
                    unknownSymbolCandidateLines.push(lineNo);
                }
                if (hasPotentialAssignment || hasMutationOperator || mayStartDeclarationValidation) {
                    declarationDiagnosticCandidateLineFlags[lineNo] = 1;
                    declarationDiagnosticCandidateLines.push(lineNo);
                }
                const hasBitwiseAndOrCandidate = charSignals.hasAmpersandOrPipeChar && BITWISE_AND_OR_CANDIDATE_RE.test(trimmed);
                const hasComparisonOrLogicalCandidate = (
                    charSignals.hasAmpersandOrPipeChar ||
                    charSignals.hasComparisonOrLogicalChar ||
                    hasAssignmentChar
                ) && COMPARISON_OR_LOGICAL_CANDIDATE_RE.test(trimmed);
                if (
                    (trimmed.indexOf('sizeof') >= 0 && SIZEOF_KEYWORD_RE.test(trimmed)) ||
                    (hasBitwiseAndOrCandidate && hasComparisonOrLogicalCandidate)
                ) {
                    expressionOperatorCandidateLineFlags[lineNo] = 1;
                    expressionOperatorCandidateLines.push(lineNo);
                }
                const hasRationalLiteralCandidate = charSignals.hasDigitChar &&
                    charSignals.hasDotChar &&
                    RATIONAL_LITERAL_CANDIDATE_RE.test(trimmed);

                const startsWithKnownDeclarationOrControl =
                    isAtPublicFunctionStartLine(trimmed) ||
                    startsWithDeclarationOrControlKeyword(trimmed);
                const mayNeedStrayTokenValidation =
                    !isPreprocessorLine &&
                    !BRACE_ONLY_OPTIONAL_SEMI_RE.test(trimmed) &&
                    !startsWithKnownDeclarationOrControl &&
                    !STRAY_TOKEN_ALLOWED_CONTEXT_CHAR_RE.test(trimmed) &&
                    !trimmed.endsWith(';');
                if (mayNeedStrayTokenValidation) {
                    strayTokenCandidateLineFlags[lineNo] = 1;
                    strayTokenCandidateLines.push(lineNo);
                }
                if ((flags & LINE_FLAG_HAS_DIRECTIVE_SIG) || trimmed.indexOf(':') >= 0 || GOTO_KEYWORD_RE.test(trimmed) || hasRationalLiteralCandidate) {
                    preprocessorAndLabelCandidateLineFlags[lineNo] = 1;
                    preprocessorAndLabelCandidateLines.push(lineNo);
                }

                const hasStructuralKeyword = PAWN_STRUCTURAL_KEYWORD_RE.test(trimmed);
                const hasNumericNoEffectCandidate = !hasAsciiIdentifierContent &&
                    charSignals.hasDigitChar &&
                    DIGIT_RE.test(trimmed) &&
                    trimmed.indexOf('=') < 0 &&
                    !INDEX_OR_BRACE_CHAR_RE.test(trimmed);
                if (
                    (flags & LINE_FLAG_HAS_BRACE_SIG) ||
                    hasStructuralKeyword ||
                    hasNumericNoEffectCandidate ||
                    trimmed === ';'
                ) {
                    structuralDiagnosticCandidateLineFlags[lineNo] = 1;
                    structuralDiagnosticCandidateLines.push(lineNo);
                }
            }

            if (blockCommentStartIndex >= 0) {
                coarseInBlockComment = true;
                isCommentRelevant = true;
            }
            if (blockCommentEndIndex >= 0) {
                isCommentRelevant = true;
                coarseInBlockComment = false;
            }
            if (isCommentRelevant) {
                commentRelevantLines.push(lineNo);
                commentRelevantFlags[lineNo] = 1;
            }
            lineFlags[lineNo] = flags;
        }

        return {
            lineCount,
            lineFlags,
            depthSpecialCharMask: LINE_FLAG_HAS_BRACE_SIG | LINE_FLAG_HAS_COMMENT_SIG,
            commentCandidateLines,
            commentRelevantLines,
            directiveCandidateLines,
            parenCandidateLines,
            bracketCandidateLines,
            expressionCandidateLines,
            expressionCandidateLineFlags,
            bodyDeclarationCandidateLines,
            generalDiagnosticCandidateLines,
            structuralDiagnosticCandidateLines,
            invalidCodeCharacterCandidateLines,
            unknownSymbolCandidateLines,
            declarationDiagnosticCandidateLines,
            expressionOperatorCandidateLines,
            strayTokenCandidateLines,
            preprocessorAndLabelCandidateLines,
            invalidCodeCharacterCandidateLineFlags,
            unknownSymbolCandidateLineFlags,
            declarationDiagnosticCandidateLineFlags,
            expressionOperatorCandidateLineFlags,
            strayTokenCandidateLineFlags,
            preprocessorAndLabelCandidateLineFlags,
            structuralDiagnosticCandidateLineFlags,
            backslashContinuationLines,
            braceOnlyLineFlags,
            topLevelContextChangeLines,
            bodyContextChangeLines,
            hasFlag(lineNo, flag) {
                return !!(lineFlags[lineNo] & flag);
            },
            isCommentRelevantLine(lineNo) {
                return !!commentRelevantFlags[lineNo];
            },
            isPotentialTopLevelContextChangeLine(lineNo) {
                return !!(lineFlags[lineNo] & LINE_FLAG_POTENTIAL_TOP_LEVEL_CONTEXT_CHANGE);
            },
            isPotentialBodyContextChangeLine(lineNo) {
                return !!(lineFlags[lineNo] & LINE_FLAG_POTENTIAL_BODY_CONTEXT_CHANGE);
            },
            isBraceOnlyLine(lineNo) {
                return !!braceOnlyLineFlags[lineNo];
            },
            hasParenLine(lineNo) {
                return !!(lineFlags[lineNo] & LINE_FLAG_HAS_PAREN_SIG);
            },
            isPreprocessorDirectiveLine(lineNo) {
                return !!preprocessorDirectiveLineFlags[lineNo];
            },
            hasDepthSpecialCharLine(lineNo) {
                return !!(lineFlags[lineNo] & (
                    LINE_FLAG_HAS_BRACE_SIG |
                    LINE_FLAG_HAS_COMMENT_SIG
                ));
            }
        };
    }

    return {
        buildLineIndex,
        isBodyDeclarationContextChangeLine,
        LINE_FLAG_HAS_COMMENT_SIG,
        LINE_FLAG_HAS_LINE_COMMENT_SIG,
        LINE_FLAG_HAS_BLOCK_COMMENT_SIG,
        LINE_FLAG_HAS_DIRECTIVE_SIG,
        LINE_FLAG_HAS_BRACE_SIG,
        LINE_FLAG_HAS_PAREN_SIG,
        LINE_FLAG_HAS_BRACKET_SIG,
        LINE_FLAG_POTENTIAL_TOP_LEVEL_CONTEXT_CHANGE,
        LINE_FLAG_POTENTIAL_BODY_CONTEXT_CHANGE
    };
}

module.exports = {
    createLineIndexCore,
    isBodyDeclarationContextChangeLine
};
