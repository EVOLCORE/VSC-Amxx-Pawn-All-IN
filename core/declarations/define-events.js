const {
    applyDeprecatedPragmaToNextDecl,
    parseDeprecatedPragmaMessage
} = require('./docs');

function createDefineDeclarationEventCore(deps) {
    const {
        collectDeclarationText,
        getActiveCtrlChar,
        parseDeclLine,
        parsePreprocessorDirectiveLine,
        parsePreprocessorSingleIdentifierPayload,
        stripLineComment
    } = deps;

    function collectDefineDeclarationText(rawLines, startLine, lineCtrlChars = [], scanLines = null) {
        const collected = collectDeclarationText(rawLines, startLine, lineCtrlChars, scanLines);
        if (collected.text.indexOf('//') < 0) return collected;

        let hasLineComment = false;
        for (let currentLine = startLine; currentLine < collected.nextLine; currentLine++) {
            if (String((scanLines || rawLines)[currentLine] || '').indexOf('//') >= 0) {
                hasLineComment = true;
                break;
            }
        }
        if (!hasLineComment) return collected;

        const defineLines = [];
        for (let currentLine = startLine; currentLine < collected.nextLine; currentLine++) {
            const source = String((scanLines || rawLines)[currentLine] || '');
            const escapeChar = lineCtrlChars[currentLine] || getActiveCtrlChar();
            defineLines[currentLine] = source.indexOf('//') >= 0
                ? stripLineComment(source, escapeChar)
                : source;
        }
        return collectDeclarationText(rawLines, startLine, lineCtrlChars, defineLines);
    }

    function collectActiveDefineDecls(rawLines, filePath, fileName, lineCtrlChars = [], cursorLine = undefined, strippedLines = null, directiveCandidateLines = null) {
        const activeDefines = new Map();
        const scanLines = strippedLines || rawLines;
        const candidateLines = Array.isArray(directiveCandidateLines)
            ? directiveCandidateLines
            : null;
        let cursor = 0;
        let candidateIndex = 0;
        let pendingDeprecatedMessage = null;
        while (cursor < scanLines.length) {
            const i = candidateLines
                ? candidateLines[candidateIndex++]
                : cursor;
            if (!Number.isInteger(i)) break;
            if (candidateLines && i < cursor) continue;
            if (cursorLine !== undefined && i > cursorLine) break;

            const trimmedLine = String(scanLines[i] || '').trim();
            if (!trimmedLine) {
                cursor = i + 1;
                continue;
            }
            const deprecatedMessage = parseDeprecatedPragmaMessage(trimmedLine);
            if (deprecatedMessage != null) {
                pendingDeprecatedMessage = deprecatedMessage;
                cursor = i + 1;
                continue;
            }

            const directive = parsePreprocessorDirectiveLine(trimmedLine);
            if (directive?.keyword === 'define') {
                const startLine = i;
                const { text: joinedText, nextLine } = collectDefineDeclarationText(rawLines, i, lineCtrlChars, scanLines);
                cursor = nextLine;
                const parsedDecls = parseDeclLine(
                    { text: joinedText, startLine },
                    rawLines,
                    filePath,
                    fileName,
                    'global'
                );
                if (pendingDeprecatedMessage != null && applyDeprecatedPragmaToNextDecl(parsedDecls, pendingDeprecatedMessage)) {
                    pendingDeprecatedMessage = null;
                }
                const defineDecl = parsedDecls.find(d => d.type === 'define');
                if (defineDecl) activeDefines.set(defineDecl.name, defineDecl);
                continue;
            }

            if (directive?.keyword === 'undef') {
                const parsedUndef = parsePreprocessorSingleIdentifierPayload(directive);
                if (parsedUndef?.name) activeDefines.delete(parsedUndef.name);
            }
            cursor = i + 1;
        }

        return [...activeDefines.values()];
    }

    function collectDefineDirectiveEvents(rawLines, filePath, fileName, lineCtrlChars = [], strippedLines = null, directiveCandidateLines = null) {
        const events = [];
        const scanLines = strippedLines || rawLines;
        const candidateLines = Array.isArray(directiveCandidateLines)
            ? directiveCandidateLines
            : null;
        let cursor = 0;
        let candidateIndex = 0;
        let pendingDeprecatedMessage = null;
        while (cursor < scanLines.length) {
            const i = candidateLines
                ? candidateLines[candidateIndex++]
                : cursor;
            if (!Number.isInteger(i)) break;
            if (candidateLines && i < cursor) continue;
            const trimmedLine = String(scanLines[i] || '').trim();
            if (!trimmedLine) {
                cursor = i + 1;
                continue;
            }
            const deprecatedMessage = parseDeprecatedPragmaMessage(trimmedLine);
            if (deprecatedMessage != null) {
                pendingDeprecatedMessage = deprecatedMessage;
                cursor = i + 1;
                continue;
            }

            const directive = parsePreprocessorDirectiveLine(trimmedLine);
            if (directive?.keyword === 'define') {
                const startLine = i;
                const { text: joinedText, nextLine } = collectDefineDeclarationText(rawLines, i, lineCtrlChars, scanLines);
                cursor = nextLine;
                const parsedDecls = parseDeclLine(
                    { text: joinedText, startLine },
                    rawLines,
                    filePath,
                    fileName,
                    'global'
                );
                if (pendingDeprecatedMessage != null && applyDeprecatedPragmaToNextDecl(parsedDecls, pendingDeprecatedMessage)) {
                    pendingDeprecatedMessage = null;
                }
                const defineDecl = parsedDecls.find(d => d.type === 'define');
                if (defineDecl) {
                    events.push({
                        lineNumber: startLine,
                        type: 'define',
                        name: defineDecl.name,
                        defineDecl
                    });
                }
                continue;
            }

            if (directive?.keyword === 'undef') {
                const parsedUndef = parsePreprocessorSingleIdentifierPayload(directive);
                if (!parsedUndef?.name) {
                    cursor = i + 1;
                    continue;
                }
                events.push({
                    lineNumber: i,
                    type: 'undef',
                    name: parsedUndef.name
                });
            }
            cursor = i + 1;
        }

        return events;
    }

    function advanceActiveDefineDecls(activeDefines, defineDirectiveEvents = [], fromLine, toLine, startEventIndex = 0) {
        let eventIndex = Math.max(0, startEventIndex);
        let changed = false;

        while (eventIndex < defineDirectiveEvents.length) {
            const event = defineDirectiveEvents[eventIndex];
            if (event.lineNumber < fromLine) {
                eventIndex++;
                continue;
            }
            if (event.lineNumber > toLine) break;

            if (event.type === 'define') {
                const previous = activeDefines.get(event.name) || null;
                activeDefines.set(event.name, event.defineDecl);
                if (previous !== event.defineDecl) changed = true;
            } else if (event.type === 'undef') {
                changed = activeDefines.delete(event.name) || changed;
            }

            eventIndex++;
        }

        return {
            changed,
            nextEventIndex: eventIndex
        };
    }

    return {
        advanceActiveDefineDecls,
        collectActiveDefineDecls,
        collectDefineDeclarationText,
        collectDefineDirectiveEvents
    };
}

module.exports = { createDefineDeclarationEventCore };
