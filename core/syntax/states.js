const {
    readPawnIdentifierAt
} = require('./identifiers');
const { findBalancedGroupEnd } = require('./balanced');
const { skipPawnWhitespace } = require('./whitespace');

function createStateSyntaxCore() {
    const stateModelCache = new WeakMap();

    const isOperatorName = name => /^operator/.test(String(name || ''));

    function findMatchingGroupEnd(source, openIndex, openChar, closeChar) {
        return findBalancedGroupEnd(source, openIndex, openChar, closeChar, {
            isEscapedQuote: (text, index) => text[index - 1] === '\\'
        });
    }

    function parseStateSpecBody(body, bodyOffset = 0) {
        const source = String(body || '');
        const spec = {
            fallback: source.trim().length === 0,
            entries: [],
            issues: []
        };
        if (spec.fallback) return spec;

        let cursor = 0;
        let currentAutomaton = null;
        let firstAutomaton = null;
        while (cursor < source.length) {
            cursor = skipPawnWhitespace(source, cursor);
            if (cursor >= source.length) break;

            const first = readPawnIdentifierAt(source, cursor);
            if (!first) {
                spec.issues.push({
                    kind: 'invalidStateSpecification',
                    rangeStart: bodyOffset + cursor,
                    rangeEnd: bodyOffset + Math.min(source.length, cursor + 1)
                });
                break;
            }
            cursor = skipPawnWhitespace(source, first.end);

            let automaton = currentAutomaton ?? '';
            let state = first.text;
            let stateStart = first.start;
            let stateEnd = first.end;
            let automatonStart = -1;
            let automatonEnd = -1;
            if (source[cursor] === ':') {
                automaton = first.text;
                automatonStart = first.start;
                automatonEnd = first.end;
                cursor = skipPawnWhitespace(source, cursor + 1);
                const second = readPawnIdentifierAt(source, cursor);
                if (!second) {
                    spec.issues.push({
                        kind: 'invalidStateSpecification',
                        rangeStart: bodyOffset + cursor,
                        rangeEnd: bodyOffset + Math.min(source.length, cursor + 1)
                    });
                    break;
                }
                state = second.text;
                stateStart = second.start;
                stateEnd = second.end;
                cursor = second.end;
            }

            currentAutomaton = automaton;
            if (firstAutomaton == null) {
                firstAutomaton = automaton;
            } else if (automaton !== firstAutomaton) {
                spec.issues.push({
                    kind: 'multipleAutomatonsForFunction',
                    automaton,
                    rangeStart: bodyOffset + (automatonStart >= 0 ? automatonStart : stateStart),
                    rangeEnd: bodyOffset + (automatonEnd >= 0 ? automatonEnd : stateEnd)
                });
            }

            spec.entries.push({
                automaton,
                state,
                rangeStart: bodyOffset + (automatonStart >= 0 ? automatonStart : stateStart),
                rangeEnd: bodyOffset + stateEnd,
                automatonStart: automatonStart >= 0 ? bodyOffset + automatonStart : -1,
                automatonEnd: automatonEnd >= 0 ? bodyOffset + automatonEnd : -1,
                stateStart: bodyOffset + stateStart,
                stateEnd: bodyOffset + stateEnd
            });

            cursor = skipPawnWhitespace(source, cursor);
            if (source[cursor] === ',') {
                cursor++;
                continue;
            }
            if (cursor < source.length) {
                spec.issues.push({
                    kind: 'invalidStateSpecification',
                    rangeStart: bodyOffset + cursor,
                    rangeEnd: bodyOffset + Math.min(source.length, cursor + 1)
                });
                break;
            }
        }

        return spec;
    }

    function parseFunctionStateSpecTail(tail, baseOffset = 0) {
        const text = String(tail || '');
        const start = skipPawnWhitespace(text, 0);
        if (text[start] !== '<') return null;
        const end = findMatchingGroupEnd(text, start, '<', '>');
        if (end < 0) {
            return {
                fallback: false,
                entries: [],
                issues: [{
                    kind: 'invalidStateSpecification',
                    rangeStart: baseOffset + start,
                    rangeEnd: baseOffset + Math.min(text.length, start + 1)
                }],
                start: baseOffset + start,
                end: baseOffset + Math.min(text.length, start + 1),
                raw: text.slice(start)
            };
        }

        const bodyStart = start + 1;
        const parsed = parseStateSpecBody(text.slice(bodyStart, end), baseOffset + bodyStart);
        return {
            ...parsed,
            start: baseOffset + start,
            end: baseOffset + end + 1,
            raw: text.slice(start, end + 1)
        };
    }

    function parseFunctionStateSpecFromHeaderText(headerText) {
        const text = String(headerText || '');
        const open = text.indexOf('(');
        if (open < 0) return null;
        const close = findMatchingGroupEnd(text, open, '(', ')');
        if (close < 0) return null;
        return parseFunctionStateSpecTail(text.slice(close + 1), close + 1);
    }

    function parseStateStatement(source) {
        const text = String(source || '');
        if (text.indexOf('state') < 0) return null;
        let cursor = skipPawnWhitespace(text, 0);
        const stateKeyword = readPawnIdentifierAt(text, cursor);
        if (!stateKeyword || stateKeyword.text !== 'state') return null;
        cursor = skipPawnWhitespace(text, stateKeyword.end);

        if (text[cursor] === '(') {
            const close = findMatchingGroupEnd(text, cursor, '(', ')');
            if (close < 0) {
                return {
                    keywordStart: stateKeyword.start,
                    keywordEnd: stateKeyword.end,
                    issues: [{
                        kind: 'invalidStateSpecification',
                        rangeStart: cursor,
                        rangeEnd: Math.min(text.length, cursor + 1)
                    }]
                };
            }
            cursor = skipPawnWhitespace(text, close + 1);
        }

        const first = readPawnIdentifierAt(text, cursor);
        if (!first) {
            return {
                keywordStart: stateKeyword.start,
                keywordEnd: stateKeyword.end,
                issues: [{
                    kind: 'invalidStateSpecification',
                    rangeStart: cursor,
                    rangeEnd: Math.min(text.length, cursor + 1)
                }]
            };
        }
        cursor = skipPawnWhitespace(text, first.end);

        let automaton = '';
        let state = first.text;
        let automatonStart = -1;
        let automatonEnd = -1;
        let stateStart = first.start;
        let stateEnd = first.end;
        if (text[cursor] === ':') {
            automaton = first.text;
            automatonStart = first.start;
            automatonEnd = first.end;
            cursor = skipPawnWhitespace(text, cursor + 1);
            const second = readPawnIdentifierAt(text, cursor);
            if (!second) {
                return {
                    keywordStart: stateKeyword.start,
                    keywordEnd: stateKeyword.end,
                    automaton,
                    automatonStart,
                    automatonEnd,
                    issues: [{
                        kind: 'invalidStateSpecification',
                        rangeStart: cursor,
                        rangeEnd: Math.min(text.length, cursor + 1)
                    }]
                };
            }
            state = second.text;
            stateStart = second.start;
            stateEnd = second.end;
            cursor = second.end;
        }
        cursor = skipPawnWhitespace(text, cursor);
        if (text[cursor] === ';') {
            cursor = skipPawnWhitespace(text, cursor + 1);
        }
        const trailingText = text.slice(cursor).trim();
        const hasTrailingContent = !!trailingText;

        return {
            keywordStart: stateKeyword.start,
            keywordEnd: stateKeyword.end,
            automaton,
            state,
            automatonStart,
            automatonEnd,
            stateStart,
            stateEnd,
            issues: hasTrailingContent
                ? [{
                    kind: 'invalidStateSpecification',
                    rangeStart: cursor,
                    rangeEnd: Math.min(text.length, cursor + Math.max(1, trailingText.length))
                }]
                : []
        };
    }

    function getFunctionStateEntries(functionDecl) {
        const spec = functionDecl?.stateSpec || null;
        if (!spec || spec.fallback || !Array.isArray(spec.entries)) return [];
        return spec.entries.filter(entry => entry?.state);
    }

    function getStateEntryKey(entry) {
        return `${String(entry?.automaton || '')}\u0000${String(entry?.state || '')}`;
    }

    function getFunctionOrderKey(functionDecl) {
        return [
            String(functionDecl?.filePath || functionDecl?.file || ''),
            Number.isInteger(functionDecl?.startLine) ? functionDecl.startLine : (functionDecl?.lineNumber ?? 0),
            String(functionDecl?.name || '')
        ].join('\u0000');
    }

    function buildPawnStateModel(functions = []) {
        const functionList = Array.isArray(functions) ? functions : [];
        if (stateModelCache.has(functionList)) return stateModelCache.get(functionList);

        const automata = new Map();
        const functionGroups = new Map();
        const ensureAutomaton = name => {
            const key = String(name || '');
            let automaton = automata.get(key);
            if (!automaton) {
                automaton = { name: key, states: new Set() };
                automata.set(key, automaton);
            }
            return automaton;
        };
        ensureAutomaton('');

        for (const func of functionList) {
            if (!func?.name || !func.stateSpec) continue;
            let group = functionGroups.get(func.name);
            if (!group) {
                group = {
                    name: func.name,
                    declarations: [],
                    stateDeclarations: [],
                    fallbackDeclarations: [],
                    implementedByAutomaton: new Map(),
                    firstDeclarationByAutomaton: new Map()
                };
                functionGroups.set(func.name, group);
            }
            group.declarations.push(func);
            group.stateDeclarations.push(func);
            if (func.stateSpec.fallback) {
                group.fallbackDeclarations.push(func);
                continue;
            }
            for (const entry of getFunctionStateEntries(func)) {
                const automaton = ensureAutomaton(entry.automaton);
                automaton.states.add(entry.state);
                let implemented = group.implementedByAutomaton.get(entry.automaton || '');
                if (!implemented) {
                    implemented = new Map();
                    group.implementedByAutomaton.set(entry.automaton || '', implemented);
                }
                if (!implemented.has(entry.state)) {
                    implemented.set(entry.state, []);
                }
                implemented.get(entry.state).push(func);
                if (!group.firstDeclarationByAutomaton.has(entry.automaton || '')) {
                    group.firstDeclarationByAutomaton.set(entry.automaton || '', func);
                }
            }
        }

        const model = { automata, functionGroups };
        stateModelCache.set(functionList, model);
        return model;
    }

    function compareFunctionOrder(left, right) {
        const leftKey = getFunctionOrderKey(left);
        const rightKey = getFunctionOrderKey(right);
        if (leftKey < rightKey) return -1;
        if (leftKey > rightKey) return 1;
        return 0;
    }

    function collectFunctionStateIssues(functionDecl, functions = []) {
        const spec = functionDecl?.stateSpec || null;
        if (!functionDecl?.name || !spec) return [];

        const issues = [];
        const model = buildPawnStateModel(functions);
        const group = model.functionGroups.get(functionDecl.name) || null;
        const specRange = {
            rangeStart: spec.start ?? 0,
            rangeEnd: spec.end ?? Math.max(1, spec.start ?? 0)
        };

        for (const issue of spec.issues || []) {
            if (issue.kind === 'multipleAutomatonsForFunction') {
                issues.push({
                    kind: 'multipleAutomatonsForFunction',
                    messageKey: 'validation.stateMultipleAutomatonsForFunction',
                    params: { name: functionDecl.name },
                    rangeStart: issue.rangeStart,
                    rangeEnd: issue.rangeEnd
                });
            } else {
                issues.push({
                    kind: 'invalidStateSpecification',
                    messageKey: 'validation.invalidStateSpecification',
                    rangeStart: issue.rangeStart,
                    rangeEnd: issue.rangeEnd
                });
            }
        }

        if (functionDecl.type === 'native' || isOperatorName(functionDecl.name)) {
            issues.push({
                kind: 'statefulNativeOperatorNotAllowed',
                messageKey: 'validation.statefulNativeOperatorNotAllowed',
                ...specRange
            });
        } else if (functionDecl.type === 'forward') {
            issues.push({
                kind: 'stateSpecificationOnForwardIgnored',
                messageKey: 'validation.stateSpecificationOnForwardIgnored',
                severity: 'warning',
                ...specRange
            });
        }

        const sameNameStateDecls = (group?.stateDeclarations || [])
            .filter(item => item !== functionDecl)
            .sort(compareFunctionOrder);
        const currentOrder = getFunctionOrderKey(functionDecl);
        const priorDecls = sameNameStateDecls.filter(item => getFunctionOrderKey(item) < currentOrder);
        if (spec.fallback) {
            const priorFallback = priorDecls.find(item => item.stateSpec?.fallback);
            if (priorFallback) {
                issues.push({
                    kind: 'stateConflict',
                    messageKey: 'validation.stateConflict',
                    params: { name: functionDecl.name },
                    ...specRange
                });
            }
            if (!(group?.stateDeclarations || []).some(item => item !== functionDecl && !item.stateSpec?.fallback)) {
                issues.push({
                    kind: 'noStatesDefinedForFunction',
                    messageKey: 'validation.noStatesDefinedForFunction',
                    params: { name: functionDecl.name },
                    ...specRange
                });
            }
        } else {
            const seen = new Set();
            for (const entry of getFunctionStateEntries(functionDecl)) {
                const entryKey = getStateEntryKey(entry);
                if (seen.has(entryKey)) {
                    issues.push({
                        kind: 'stateConflict',
                        messageKey: 'validation.stateConflict',
                        params: { name: functionDecl.name },
                        rangeStart: entry.rangeStart,
                        rangeEnd: entry.rangeEnd
                    });
                    continue;
                }
                seen.add(entryKey);
                const priorConflict = priorDecls.some(item =>
                    getFunctionStateEntries(item).some(priorEntry => getStateEntryKey(priorEntry) === entryKey)
                );
                if (priorConflict) {
                    issues.push({
                        kind: 'stateConflict',
                        messageKey: 'validation.stateConflict',
                        params: { name: functionDecl.name },
                        rangeStart: entry.rangeStart,
                        rangeEnd: entry.rangeEnd
                    });
                }
            }
        }

        if (group && !spec.fallback) {
            const hasFallback = group.fallbackDeclarations.length > 0;
            for (const [automatonName, implementedStates] of group.implementedByAutomaton.entries()) {
                if (group.firstDeclarationByAutomaton.get(automatonName) !== functionDecl) continue;
                if (hasFallback) continue;
                const automaton = model.automata.get(automatonName);
                if (!automaton) continue;
                for (const stateName of automaton.states) {
                    if (implementedStates.has(stateName)) continue;
                    issues.push({
                        kind: 'noImplementationForState',
                        messageKey: 'validation.noImplementationForState',
                        params: {
                            state: stateName,
                            name: functionDecl.name
                        },
                        severity: 'warning',
                        ...specRange
                    });
                }
            }
        }

        return issues;
    }

    function areStatefulFunctionRedeclarationsAllowed(previousDecl, currentDecl) {
        return !!(
            previousDecl?.name &&
            previousDecl.name === currentDecl?.name &&
            previousDecl.stateSpec &&
            currentDecl?.stateSpec
        );
    }

    function getStateStatementIssues(source, functions = []) {
        const parsed = parseStateStatement(source);
        if (!parsed) return [];
        const issues = [...(parsed.issues || []).map(issue => ({
            ...issue,
            messageKey: 'validation.invalidStateSpecification'
        }))];
        if (!parsed.state) return issues;

        const model = buildPawnStateModel(functions);
        const automatonName = parsed.automaton || '';
        const automaton = model.automata.get(automatonName);
        if (parsed.automaton && !automaton) {
            issues.push({
                kind: 'unknownAutomaton',
                messageKey: 'validation.unknownAutomaton',
                params: { name: parsed.automaton },
                rangeStart: parsed.automatonStart,
                rangeEnd: parsed.automatonEnd
            });
            return issues;
        }
        if (!automaton?.states?.has(parsed.state)) {
            issues.push({
                kind: 'unknownStateForAutomaton',
                messageKey: 'validation.unknownStateForAutomaton',
                params: {
                    state: parsed.state,
                    automaton: automatonName || '<main>'
                },
                rangeStart: parsed.stateStart,
                rangeEnd: parsed.stateEnd
            });
        }
        return issues;
    }

    return {
        parseFunctionStateSpecTail,
        parseFunctionStateSpecFromHeaderText,
        parseStateStatement,
        buildPawnStateModel,
        collectFunctionStateIssues,
        areStatefulFunctionRedeclarationsAllowed,
        getStateStatementIssues
    };
}

module.exports = { createStateSyntaxCore };
