const {
    isExplicitDeclarationStartLine,
    isPreprocessorDirectiveLine
} = require('./line-utils');
const {
    hasOddTrailingBackslashContinuation,
    removeTrailingBackslashContinuation
} = require('../syntax/continuation');
const { findBalancedGroupEnd } = require('../syntax/balanced');

function computeFunctionRangeMaps(functions = [], depths = [], lineCount = 0, options = {}) {
    const includeHeader = options?.includeHeader === true;
    const maxLine = Math.max(0, Number.isInteger(lineCount) ? lineCount : depths.length) - 1;
    const byLine = new Array(Math.max(0, maxLine + 1)).fill(null);
    const byFunction = new Map();

    const assignRange = range => {
        if (!range) return;
        byFunction.set(range.func, range);
        for (let line = Math.max(0, range.startLine); line <= range.endLine && line <= maxLine; line++) {
            const current = byLine[line];
            if (
                !current ||
                range.startLine > current.startLine ||
                (range.startLine === current.startLine && range.endLine < current.endLine)
            ) {
                byLine[line] = range;
            }
        }
    };

    const sortedFunctionStartLines = (functions || [])
        .map(func => func?.startLine ?? func?.lineNumber)
        .filter(Number.isInteger)
        .sort((left, right) => left - right);
    const findNextFunctionStartLine = lineNumber => {
        let low = 0;
        let high = sortedFunctionStartLines.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (sortedFunctionStartLines[mid] <= lineNumber) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low < sortedFunctionStartLines.length ? sortedFunctionStartLines[low] : -1;
    };

    for (const func of functions || []) {
        if (!func) continue;
        const headerStartLine = func.startLine ?? func.lineNumber ?? 0;
        const headerEndLine = func.headerEndLine ?? headerStartLine;
        const headerDepth = depths[headerEndLine] ?? 0;
        const nextFunctionStartLine = findNextFunctionStartLine(headerStartLine);
        const scanMaxLine = nextFunctionStartLine >= 0
            ? Math.min(maxLine, nextFunctionStartLine - 1)
            : maxLine;

        let bodyStartLine = -1;
        let bodyEndLine = -1;
        let bodyDepth = 0;

        if (Number.isInteger(func.singleStatementBodyLine)) {
            bodyStartLine = func.singleStatementBodyLine;
            bodyEndLine = func.singleStatementBodyLine;
            bodyDepth = headerDepth + 1;
        } else {
            for (let probeLine = headerEndLine + 1; probeLine <= scanMaxLine && probeLine < depths.length; probeLine++) {
                const probeDepth = depths[probeLine] ?? 0;
                if (probeDepth > headerDepth) {
                    bodyStartLine = probeLine;
                    bodyDepth = probeDepth;
                    break;
                }
            }

            if (bodyStartLine >= 0) {
                bodyEndLine = bodyStartLine;
                for (let probeLine = bodyStartLine + 1; probeLine <= scanMaxLine && probeLine < depths.length; probeLine++) {
                    if ((depths[probeLine] ?? 0) < bodyDepth) {
                        bodyEndLine = probeLine - 1;
                        break;
                    }
                    bodyEndLine = probeLine;
                }
            }
        }

        if (bodyStartLine < 0) {
            if (!includeHeader) continue;
            assignRange({
                func,
                startLine: Math.max(0, headerStartLine),
                endLine: Math.min(maxLine, headerEndLine),
                bodyStartLine: -1,
                bodyEndLine: -1,
                bodyDepth: 0
            });
            continue;
        }

        assignRange({
            func,
            startLine: includeHeader ? Math.max(0, headerStartLine) : Math.max(0, bodyStartLine),
            endLine: Math.min(maxLine, bodyEndLine),
            bodyStartLine,
            bodyEndLine,
            bodyDepth
        });
    }

    return { byLine, byFunction };
}

// Shared declaration-scope helpers. These are used by declaration parsing,
// include scanning, and declaration guards, so keeping them together avoids
// subtle scope drift between features.
function createDeclarationScopeCore(deps) {
    const {
        getActiveCtrlChar,
        isEscapedQuote,
        stripLineComment,
        netParenDepth,
        parseForInit,
        parseDeclLine
    } = deps;

    function findDepthScopeEndLine(depths, startLine, scopeDepth) {
        for (let i = startLine + 1; i < depths.length; i++) {
            if (depths[i] < scopeDepth) return i - 1;
        }
        return Math.max(0, depths.length - 1);
    }

    function findMatchingParenInLine(line, openParenIndex, escapeChar = getActiveCtrlChar()) {
        return findBalancedGroupEnd(line, openParenIndex, '(', ')', {
            escapeChar,
            isEscapedQuote
        });
    }

    function findStatementScopeEndLine(lines, depths, startLine, startColumn, baseDepth, lineCtrlChars = []) {
        let parenD = 0, bracketD = 0, inStr = false, strCh = '';
        let sawToken = false;

        for (let lineNo = startLine; lineNo < lines.length; lineNo++) {
            const escapeChar = lineCtrlChars[lineNo] || getActiveCtrlChar();
            const line = lines[lineNo] || '';
            for (let i = lineNo === startLine ? startColumn : 0; i < line.length; i++) {
                const c = line[i];
                if (inStr) {
                    if (c === strCh && !isEscapedQuote(line, i, escapeChar)) inStr = false;
                    continue;
                }
                if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
                if (c === '(') parenD++;
                else if (c === ')') parenD = Math.max(0, parenD - 1);
                else if (c === '[') bracketD++;
                else if (c === ']') bracketD = Math.max(0, bracketD - 1);
                else if (c === ';' && parenD === 0 && bracketD === 0 && sawToken) {
                    return lineNo;
                } else if (c === '{' && parenD === 0 && bracketD === 0) {
                    return findDepthScopeEndLine(depths, lineNo, baseDepth + 1);
                } else if (/\S/.test(c)) {
                    sawToken = true;
                }
            }
        }

        return Math.max(startLine, lines.length - 1);
    }

    function findForScopeEndLine(lines, depths, lineNumber, lineCtrlChars = []) {
        const escapeChar = lineCtrlChars[lineNumber] || getActiveCtrlChar();
        const line = lines[lineNumber] || '';
        const forMatch = line.match(/^\s*for\s*\(/);
        if (!forMatch) return findDepthScopeEndLine(depths, lineNumber, depths[lineNumber] ?? 0);

        const openParenIndex = line.indexOf('(', forMatch.index);
        const closeParenIndex = findMatchingParenInLine(line, openParenIndex, escapeChar);
        if (closeParenIndex < 0) return findDepthScopeEndLine(depths, lineNumber, depths[lineNumber] ?? 0);

        const remainder = line.slice(closeParenIndex + 1);
        if (remainder.trim()) {
            if (remainder.trimStart().startsWith('{')) {
                return findStatementScopeEndLine(
                    lines,
                    depths,
                    lineNumber,
                    closeParenIndex + 1,
                    depths[lineNumber] ?? 0,
                    lineCtrlChars
                );
            }
            return startsWithSingleStatementControl(remainder)
                ? findSingleStatementControlEndLine(lines, depths, lineNumber, lineCtrlChars)
                : lineNumber;
        }

        const bodyLine = findNextSignificantLine(lines, lineNumber + 1, lineCtrlChars);
        if (bodyLine < 0) return lineNumber;
        const bodyText = String(lines[bodyLine] || '').trimStart();
        if (bodyText.startsWith('{')) {
            return findDepthScopeEndLine(depths, bodyLine, (depths[lineNumber] ?? 0) + 1);
        }
        return startsWithSingleStatementControl(bodyText)
            ? findSingleStatementControlEndLine(lines, depths, bodyLine, lineCtrlChars)
            : bodyLine;
    }

    function findNextSignificantLine(lines, startLine, lineCtrlChars = []) {
        for (let i = startLine; i < lines.length; i++) {
            const line = lines[i] || '';
            if (line.trim()) return i;
        }
        return -1;
    }

    function findPreviousSignificantLine(lines, startLine) {
        for (let i = Math.min(startLine, lines.length - 1); i >= 0; i--) {
            const line = lines[i] || '';
            if (line.trim()) return i;
        }
        return -1;
    }

    function startsWithSingleStatementControl(line) {
        const source = String(line || '').trimStart();
        return /^(?:if|while|for)\s*\(/.test(source) ||
            /^else\s+if\s*\(/.test(source) ||
            /^else\b/.test(source) ||
            /^do\b/.test(source);
    }

    function findBraceBodyEndLine(lines, depths, controlLine, bodyLine, baseDepth) {
        const bodyText = String(lines[bodyLine] || '').trimStart();
        if (!bodyText.startsWith('{')) return null;
        return findDepthScopeEndLine(depths, bodyLine, baseDepth + 1);
    }

    function findControlBraceBodyEndLine(lines, depths, lineNumber, lineCtrlChars = []) {
        const escapeChar = lineCtrlChars[lineNumber] || getActiveCtrlChar();
        const line = lines[lineNumber] || '';
        const baseDepth = depths[lineNumber] ?? 0;

        const elseIfMatch = line.match(/^\s*else\s+if\s*\(/);
        if (elseIfMatch) {
            const openParenIndex = line.indexOf('(', elseIfMatch.index);
            const closeParenIndex = findMatchingParenInLine(line, openParenIndex, escapeChar);
            if (closeParenIndex < 0) return null;
            const remainder = line.slice(closeParenIndex + 1);
            if (remainder.trim()) {
                const offset = closeParenIndex + 1 + remainder.search(/\S/);
                return line.slice(offset).trimStart().startsWith('{')
                    ? findStatementScopeEndLine(lines, depths, lineNumber, offset, baseDepth, lineCtrlChars)
                    : null;
            }
            const bodyLine = findNextSignificantLine(lines, lineNumber + 1, lineCtrlChars);
            return bodyLine >= 0 ? findBraceBodyEndLine(lines, depths, lineNumber, bodyLine, baseDepth) : null;
        }

        const controlMatch = line.match(/^\s*(if|while|for)\s*\(/);
        if (controlMatch) {
            if (controlMatch[1] === 'while' && isDoWhileTerminatorLine(lines, depths, lineNumber, lineCtrlChars)) {
                return null;
            }
            const openParenIndex = line.indexOf('(', controlMatch.index);
            const closeParenIndex = findMatchingParenInLine(line, openParenIndex, escapeChar);
            if (closeParenIndex < 0) return null;
            const remainder = line.slice(closeParenIndex + 1);
            if (remainder.trim()) {
                const offset = closeParenIndex + 1 + remainder.search(/\S/);
                return line.slice(offset).trimStart().startsWith('{')
                    ? findStatementScopeEndLine(lines, depths, lineNumber, offset, baseDepth, lineCtrlChars)
                    : null;
            }
            const bodyLine = findNextSignificantLine(lines, lineNumber + 1, lineCtrlChars);
            return bodyLine >= 0 ? findBraceBodyEndLine(lines, depths, lineNumber, bodyLine, baseDepth) : null;
        }

        const elseMatch = line.match(/^\s*else\b/);
        if (elseMatch) {
            const remainder = line.slice(elseMatch.index + elseMatch[0].length);
            if (remainder.trim()) {
                if (/^\s*if\b/.test(remainder)) return null;
                const offset = elseMatch.index + elseMatch[0].length + remainder.search(/\S/);
                return line.slice(offset).trimStart().startsWith('{')
                    ? findStatementScopeEndLine(lines, depths, lineNumber, offset, baseDepth, lineCtrlChars)
                    : null;
            }
            const bodyLine = findNextSignificantLine(lines, lineNumber + 1, lineCtrlChars);
            return bodyLine >= 0 ? findBraceBodyEndLine(lines, depths, lineNumber, bodyLine, baseDepth) : null;
        }

        const doMatch = line.match(/^\s*do\b/);
        if (doMatch) {
            const remainder = line.slice(doMatch.index + doMatch[0].length);
            if (remainder.trim()) {
                const offset = doMatch.index + doMatch[0].length + remainder.search(/\S/);
                return line.slice(offset).trimStart().startsWith('{')
                    ? findStatementScopeEndLine(lines, depths, lineNumber, offset, baseDepth, lineCtrlChars)
                    : null;
            }
            const bodyLine = findNextSignificantLine(lines, lineNumber + 1, lineCtrlChars);
            return bodyLine >= 0 ? findBraceBodyEndLine(lines, depths, lineNumber, bodyLine, baseDepth) : null;
        }

        return null;
    }

    function isDoWhileTerminatorLine(lines, depths, lineNumber, lineCtrlChars = []) {
        const line = String(lines[lineNumber] || '').trimStart();
        if (!/^while\s*\(/.test(line)) return false;

        const previousLine = findPreviousSignificantLine(lines, lineNumber - 1);
        if (previousLine < 0) return false;
        if (!String(lines[previousLine] || '').trimStart().startsWith('}')) return false;

        const baseDepth = depths[lineNumber] ?? 0;
        for (let probe = previousLine; probe >= 0; probe--) {
            if ((depths[probe] ?? 0) !== baseDepth) continue;
            const openBraceIndex = String(lines[probe] || '').indexOf('{');
            if (openBraceIndex < 0) continue;

            const beforeBrace = String(lines[probe] || '').slice(0, openBraceIndex).trim();
            if (/^do\b/.test(beforeBrace)) return true;

            const doLine = findPreviousSignificantLine(lines, probe - 1);
            return doLine >= 0 && /^do\b/.test(String(lines[doLine] || '').trimStart());
        }

        return false;
    }

    function findControlStatementBodyStart(lines, depths, lineNumber, lineCtrlChars = []) {
        const escapeChar = lineCtrlChars[lineNumber] || getActiveCtrlChar();
        const line = lines[lineNumber] || '';
        const elseIfMatch = line.match(/^\s*else\s+if\s*\(/);
        if (elseIfMatch) {
            const openParenIndex = line.indexOf('(', elseIfMatch.index);
            const closeParenIndex = findMatchingParenInLine(line, openParenIndex, escapeChar);
            if (closeParenIndex < 0) return null;
            const remainder = line.slice(closeParenIndex + 1);
            if (remainder.trim()) {
                if (remainder.trimStart().startsWith('{')) return null;
                return { type: 'else-if', bodyLine: lineNumber, startColumn: closeParenIndex + 1 + remainder.search(/\S/) };
            }
            const bodyLine = findNextSignificantLine(lines, lineNumber + 1, lineCtrlChars);
            if (bodyLine < 0) return null;
            const nextLine = lines[bodyLine] || '';
            if (nextLine.trimStart().startsWith('{')) return null;
            return { type: 'else-if', bodyLine, startColumn: nextLine.search(/\S/) };
        }

        const controlMatch = line.match(/^\s*(if|while|for)\s*\(/);
        if (controlMatch) {
            if (controlMatch[1] === 'while' && isDoWhileTerminatorLine(lines, depths, lineNumber, lineCtrlChars)) {
                return null;
            }
            const openParenIndex = line.indexOf('(', controlMatch.index);
            const closeParenIndex = findMatchingParenInLine(line, openParenIndex, escapeChar);
            if (closeParenIndex < 0) return null;
            const remainder = line.slice(closeParenIndex + 1);
            if (remainder.trim()) {
                if (remainder.trimStart().startsWith('{')) return null;
                return { type: controlMatch[1], bodyLine: lineNumber, startColumn: closeParenIndex + 1 + remainder.search(/\S/) };
            }
            const bodyLine = findNextSignificantLine(lines, lineNumber + 1, lineCtrlChars);
            if (bodyLine < 0) return null;
            const nextLine = lines[bodyLine] || '';
            if (nextLine.trimStart().startsWith('{')) return null;
            return { type: controlMatch[1], bodyLine, startColumn: nextLine.search(/\S/) };
        }

        const elseMatch = line.match(/^\s*else\b/);
        if (elseMatch) {
            const remainder = line.slice(elseMatch.index + elseMatch[0].length);
            if (remainder.trim()) {
                if (/^\s*if\b/.test(remainder) || remainder.trimStart().startsWith('{')) return null;
                return { type: 'else', bodyLine: lineNumber, startColumn: elseMatch.index + elseMatch[0].length + remainder.search(/\S/) };
            }
            const bodyLine = findNextSignificantLine(lines, lineNumber + 1, lineCtrlChars);
            if (bodyLine < 0) return null;
            const nextLine = lines[bodyLine] || '';
            if (/^\s*if\b/.test(nextLine) || nextLine.trimStart().startsWith('{')) return null;
            return { type: 'else', bodyLine, startColumn: nextLine.search(/\S/) };
        }

        const doMatch = line.match(/^\s*do\b/);
        if (doMatch) {
            const remainder = line.slice(doMatch.index + doMatch[0].length);
            if (remainder.trim()) {
                if (remainder.trimStart().startsWith('{')) return null;
                return { type: 'do', bodyLine: lineNumber, startColumn: doMatch.index + doMatch[0].length + remainder.search(/\S/) };
            }
            const bodyLine = findNextSignificantLine(lines, lineNumber + 1, lineCtrlChars);
            if (bodyLine < 0) return null;
            const nextLine = lines[bodyLine] || '';
            if (nextLine.trimStart().startsWith('{')) return null;
            return { type: 'do', bodyLine, startColumn: nextLine.search(/\S/) };
        }

        return null;
    }

    function findSingleStatementControlEndLine(lines, depths, lineNumber, lineCtrlChars = [], seen = new Set()) {
        if (!Number.isInteger(lineNumber) || lineNumber < 0 || seen.has(lineNumber)) {
            return Math.max(0, lineNumber || 0);
        }
        seen.add(lineNumber);
        const bodyInfo = findControlStatementBodyStart(lines, depths, lineNumber, lineCtrlChars);
        if (!bodyInfo) return lineNumber;
        const bodyLine = bodyInfo.bodyLine;
        const bodyText = String(lines[bodyLine] || '').slice(bodyInfo.startColumn).trimStart();
        if (!bodyText || bodyText.startsWith('{')) return bodyLine;
        if (startsWithSingleStatementControl(bodyText)) {
            const nestedBraceEndLine = findControlBraceBodyEndLine(lines, depths, bodyLine, lineCtrlChars);
            return nestedBraceEndLine != null
                ? nestedBraceEndLine
                : findSingleStatementControlEndLine(lines, depths, bodyLine, lineCtrlChars, seen);
        }
        return bodyLine;
    }

    function parseSingleStatementBodyDecls(lines, rawLines, depths, filePath, fileName, fromLine, toLine, lineCtrlChars = []) {
        const byLine = new Map();

        for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber++) {
            const bodyInfo = findControlStatementBodyStart(lines, depths, lineNumber, lineCtrlChars);
            if (!bodyInfo) continue;

            const bodyLineText = lines[bodyInfo.bodyLine] || '';
            const bodyText = bodyLineText.slice(bodyInfo.startColumn).trim();
            if (!bodyText) continue;

            let decls = [];
            if (/^for\s*\(/.test(bodyText)) {
                decls = parseForInit(
                    bodyText,
                    rawLines,
                    filePath,
                    fileName,
                    bodyInfo.bodyLine,
                    lineCtrlChars[bodyInfo.bodyLine] || getActiveCtrlChar()
                );
            } else {
                decls = parseDeclLine(
                    { text: bodyText, startLine: bodyInfo.bodyLine },
                    rawLines,
                    filePath,
                    fileName,
                    'local'
                );
            }
            if (!decls.length) continue;

            const scopeEndLine = decls.some(decl => decl?.isForVar)
                ? findSingleStatementControlEndLine(lines, depths, lineNumber, lineCtrlChars)
                : bodyInfo.bodyLine;

            byLine.set(bodyInfo.bodyLine, {
                decls,
                declDepth: depths[bodyInfo.bodyLine] ?? 0,
                scopeEndLine
            });
        }

        return byLine;
    }

    function hasTrailingLineContinuation(line, escapeChar = getActiveCtrlChar(), preparedLine = null) {
        const stripped = String(preparedLine ?? stripLineComment(String(line || ''), escapeChar)).trimEnd();
        return hasOddTrailingBackslashContinuation(stripped);
    }

    function netParenBraceDepth(line, escapeChar = getActiveCtrlChar()) {
        const source = String(line || '');
        let parenDepth = 0;
        let braceDepth = 0;
        let inStr = false;
        let strCh = '';
        for (let i = 0; i < source.length; i++) {
            const c = source[i];
            if (inStr) {
                if (c === strCh && !isEscapedQuote(source, i, escapeChar)) inStr = false;
                continue;
            }
            if (c === '"' || c === "'") {
                inStr = true;
                strCh = c;
                continue;
            }
            if (c === '(') parenDepth++;
            else if (c === ')') parenDepth--;
            else if (c === '{') braceDepth++;
            else if (c === '}') braceDepth--;
        }
        return { parenDepth, braceDepth };
    }

    function collectDeclarationText(rawLines, startLine, lineCtrlChars = [], preparedLines = null) {
        let i = startLine;
        const sourceLines = preparedLines || rawLines;
        let escapeChar = lineCtrlChars[i] || getActiveCtrlChar();
        let joined = sourceLines[i] || '';
        const initialRawLine = rawLines[i] || '';
        const initialTrimmed = joined.trimEnd();
        const startsBraceInitializer = /=\s*$/.test(initialTrimmed);
        if (
            joined.indexOf('(') < 0 &&
            joined.indexOf(')') < 0 &&
            !initialTrimmed.endsWith(',') &&
            !startsBraceInitializer &&
            initialRawLine.indexOf('\\') < 0
        ) {
            return { text: joined, nextLine: i + 1 };
        }
        let depths = netParenBraceDepth(joined, escapeChar);
        let pd = depths.parenDepth;
        let bd = depths.braceDepth;
        let hasLineContinuation = hasTrailingLineContinuation(rawLines[i] || '', escapeChar, sourceLines[i] || '');
        let awaitingBraceInitializer = startsBraceInitializer;
        i++;

        while ((pd > 0 || bd > 0 || hasLineContinuation || awaitingBraceInitializer) && i < rawLines.length) {
            if (hasLineContinuation) {
                joined = removeTrailingBackslashContinuation(joined).trimEnd();
            }
            escapeChar = lineCtrlChars[i] || getActiveCtrlChar();
            const cont = sourceLines[i] || '';
            joined += ' ' + cont.trim();
            depths = netParenBraceDepth(cont, escapeChar);
            pd += depths.parenDepth;
            bd += depths.braceDepth;
            hasLineContinuation = hasTrailingLineContinuation(rawLines[i] || '', escapeChar, sourceLines[i] || '');
            awaitingBraceInitializer = false;
            i++;
        }

        while (joined.trimEnd().endsWith(',') && i < rawLines.length) {
            const cont = sourceLines[i] || '';
            const trimmedCont = String(cont || '').trim();
            if (!trimmedCont || isPreprocessorDirectiveLine(trimmedCont) || isExplicitDeclarationStartLine(trimmedCont)) {
                break;
            }
            joined += ' ' + cont.trim();
            i++;
        }

        return { text: joined, nextLine: i };
    }

    function collectForHeaderText(rawLines, startLine, lineCtrlChars = [], preparedLines = null) {
        const sourceLines = preparedLines || rawLines;
        let joined = '';
        let parenDepth = 0;
        let sawOpenParen = false;
        let inString = false;
        let stringChar = '';
        let i = startLine;

        for (; i < rawLines.length; i++) {
            const line = String(sourceLines[i] || '');
            const escapeChar = lineCtrlChars[i] || getActiveCtrlChar();
            joined += (i === startLine ? '' : ' ') + line.trim();

            for (let index = 0; index < line.length; index++) {
                const char = line[index];
                if (inString) {
                    if (char === stringChar && !isEscapedQuote(line, index, escapeChar)) {
                        inString = false;
                    }
                    continue;
                }
                if (char === '"' || char === "'") {
                    inString = true;
                    stringChar = char;
                    continue;
                }
                if (char === '(') {
                    sawOpenParen = true;
                    parenDepth++;
                    continue;
                }
                if (char === ')' && sawOpenParen) {
                    parenDepth--;
                    if (parenDepth <= 0) {
                        return { text: joined, nextLine: i + 1 };
                    }
                }
            }
        }

        return { text: joined, nextLine: Math.max(startLine + 1, i) };
    }

    return {
        findDepthScopeEndLine,
        computeFunctionRangeMaps,
        findMatchingParenInLine,
        findStatementScopeEndLine,
        findForScopeEndLine,
        findNextSignificantLine,
        findControlStatementBodyStart,
        parseSingleStatementBodyDecls,
        collectDeclarationText,
        collectForHeaderText
    };
}

module.exports = { createDeclarationScopeCore, computeFunctionRangeMaps };
