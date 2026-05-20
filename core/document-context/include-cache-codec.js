const { splitPawnLines } = require('../syntax/lines');

function createIncludeCacheCodec({ normalizeFsPath, getDefineStateKey, getDefineStateSignature }) {
    const INCLUDE_DECL_COMPACT_KEYS = [
        'name',
        'args',
        'macroStyle',
        'macroIndexer',
        'type',
        'typeTag',
        'dims',
        'file',
        'filePath',
        'lineNumber',
        'value',
        'enumName',
        'enumDisplayName',
        'valueDisplay',
        'startLine',
        'headerEndLine',
        'singleStatementBodyLine',
        'modifiers',
        'deprecated',
        'deprecatedMessage',
        'sourcePriority',
        'includeSourcePath',
        'includeResolutionKind'
    ];
    const DEFINE_DECL_COMPACT_KEYS = [
        'name',
        'args',
        'macroStyle',
        'macroIndexer',
        'type',
        'value',
        'deprecated',
        'deprecatedMessage'
    ];
    const INCLUDE_DECL_COMPACT_SCHEMA_VERSION = 'v4-include-source-priority';
    const INCLUDE_DECL_COMPACT_SIGNATURE = `${INCLUDE_DECL_COMPACT_SCHEMA_VERSION}|${INCLUDE_DECL_COMPACT_KEYS.join('|')}`;

    function serializeDependencyStamps(dependencyStamps) {
        if (!(dependencyStamps instanceof Map)) return [];
        return [...dependencyStamps.entries()].map(([filePath, stamp]) => [filePath, stamp]);
    }

    function deserializeDependencyStamps(serializedStamps = []) {
        if (!Array.isArray(serializedStamps)) return null;
        const stamps = new Map();
        for (const item of serializedStamps) {
            if (!Array.isArray(item) || item.length < 2) return null;
            const normalizedPath = normalizeFsPath(item[0]);
            if (!normalizedPath) return null;
            stamps.set(normalizedPath, item[1]);
        }
        return stamps;
    }

    function isEmptyCompactValue(value) {
        return value === undefined ||
            value === null ||
            value === '' ||
            (Array.isArray(value) && value.length === 0);
    }

    function serializeCompactObject(source, keys) {
        const values = keys.map(key => {
            const value = source?.[key];
            return Array.isArray(value) ? [...value] : value;
        });
        while (values.length && isEmptyCompactValue(values[values.length - 1])) {
            values.pop();
        }
        return values;
    }

    function reviveCompactObject(serialized, keys) {
        if (!Array.isArray(serialized)) {
            return serialized && typeof serialized === 'object' ? { ...serialized } : {};
        }
        const revived = {};
        for (let index = 0; index < serialized.length && index < keys.length; index++) {
            const value = serialized[index];
            if (value === undefined || value === null || value === '') continue;
            revived[keys[index]] = Array.isArray(value) ? [...value] : value;
        }
        return revived;
    }

    function serializeIncludeDecl(decl) {
        if (!decl || typeof decl !== 'object') return null;
        return serializeCompactObject(decl, INCLUDE_DECL_COMPACT_KEYS);
    }

    function serializeIncludeDecls(decls = []) {
        return (decls || []).map(serializeIncludeDecl).filter(Boolean);
    }

    function serializeDefineDecl(decl) {
        if (!decl || typeof decl !== 'object') return null;
        const serialized = serializeCompactObject(decl, DEFINE_DECL_COMPACT_KEYS);
        return serialized[0] ? serialized : null;
    }

    function serializeDefineDecls(defineDecls = []) {
        return (defineDecls || []).map(serializeDefineDecl).filter(Boolean);
    }

    function reviveDefineDecl(serialized) {
        const revived = reviveCompactObject(serialized, DEFINE_DECL_COMPACT_KEYS);
        return revived.name ? revived : null;
    }

    function reviveDefineDecls(defineDecls = []) {
        return (defineDecls || []).map(reviveDefineDecl).filter(Boolean);
    }

    function areSerializedDefineDeclsEqual(left, right) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        for (let index = 0; index < left.length; index++) {
            const leftValue = left[index];
            const rightValue = right[index];
            if (Array.isArray(leftValue) || Array.isArray(rightValue)) {
                if (!areSerializedDefineDeclsEqual(leftValue, rightValue)) return false;
            } else if (leftValue !== rightValue) {
                return false;
            }
        }
        return true;
    }

    function getSerializedDefineDeclPrefixLength(previousDecls = [], nextDecls = []) {
        const limit = Math.min(previousDecls.length, nextDecls.length);
        let index = 0;
        for (; index < limit; index++) {
            if (!areSerializedDefineDeclsEqual(previousDecls[index], nextDecls[index])) break;
        }
        return index;
    }

    function attachLazyDefineStateKey(target, defineDecls = [], initialDefineStateKey = '') {
        if (!target || typeof target !== 'object') return target;
        const initialKey = String(initialDefineStateKey || '');
        if (initialKey || !Array.isArray(defineDecls) || defineDecls.length === 0) {
            target.defineStateKey = initialKey;
            return target;
        }
        let cachedKey = '';
        Object.defineProperty(target, 'defineStateKey', {
            enumerable: true,
            configurable: true,
            get() {
                if (!cachedKey) {
                    cachedKey = getDefineStateKey(defineDecls);
                }
                Object.defineProperty(target, 'defineStateKey', {
                    enumerable: true,
                    configurable: true,
                    writable: true,
                    value: cachedKey
                });
                return cachedKey;
            }
        });
        return target;
    }

    function getStoredDefineStateKeyWithoutComputing(source) {
        if (!source || typeof source !== 'object') return '';
        const descriptor = Object.getOwnPropertyDescriptor(source, 'defineStateKey');
        return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
            ? String(descriptor.value || '')
            : '';
    }

    function createDefineStateRefTable() {
        const rows = [];
        const keyToIndex = new Map();
        const getRef = (defineDecls = [], defineStateKey = '') => {
            const serializedDecls = serializeDefineDecls(defineDecls || []);
            const signature = getDefineStateSignature(defineDecls || [], defineStateKey);
            if (!signature && serializedDecls.length === 0) return -1;
            const existing = keyToIndex.get(signature);
            if (existing !== undefined) return existing;
            const index = rows.length;
            keyToIndex.set(signature, index);
            rows.push(['', serializedDecls]);
            return index;
        };
        return { rows, getRef };
    }

    function serializeDefineStateDeltaTable(fullRows = [], baseDecls = null) {
        let previousDecls = Array.isArray(baseDecls) ? baseDecls : [];
        return (fullRows || []).map(row => {
            const defineDecls = Array.isArray(row?.[1]) ? row[1] : [];
            const prefixLength = getSerializedDefineDeclPrefixLength(previousDecls, defineDecls);
            const deltaDecls = defineDecls.slice(prefixLength);
            previousDecls = defineDecls;
            return [prefixLength, deltaDecls];
        });
    }

    function reviveDefineStateDeltaTable(serializedRefs = [], baseDefineDecls = null) {
        if (!Array.isArray(serializedRefs)) return [];
        let previousDecls = Array.isArray(baseDefineDecls) ? baseDefineDecls.slice() : [];
        return serializedRefs.map(row => {
            const prefixLength = Math.max(0, Math.min(
                previousDecls.length,
                Number.isInteger(row?.[0]) ? row[0] : 0
            ));
            const deltaDecls = reviveDefineDecls(row?.[1] || []);
            const defineDecls = previousDecls.slice(0, prefixLength).concat(deltaDecls);
            previousDecls = defineDecls;
            return attachLazyDefineStateKey({ defineDecls }, defineDecls);
        });
    }

    function serializeIncludeEntryWithDefineRefs(entry, getDefineRef) {
        if (!entry || typeof entry !== 'object') return null;
        const filePath = normalizeFsPath(entry.filePath || '');
        if (!filePath) return null;
        const defineRef = getDefineRef(entry.defineDecls || [], entry.defineStateKey || '');
        const depth = Number.isInteger(entry.depth) ? entry.depth : 0;
        const serialized = [
            String(entry.name || ''),
            entry.filePath
        ];
        if (defineRef >= 0 || depth !== 0) {
            serialized[2] = defineRef >= 0 ? defineRef : '';
        }
        if (depth !== 0) {
            serialized[3] = depth;
        }
        if (entry.rationalState?.tagName) {
            serialized[4] = [
                String(entry.rationalState.tagName || ''),
                entry.rationalState.digits | 0
            ];
        }
        if (Number.isFinite(entry.sourcePriority)) {
            serialized[5] = entry.sourcePriority;
        }
        if (entry.sourcePath) {
            serialized[6] = String(entry.sourcePath || '');
        }
        if (entry.resolutionKind) {
            serialized[7] = String(entry.resolutionKind || '');
        }
        return serialized;
    }

    function reviveRationalState(serialized) {
        if (!Array.isArray(serialized) || !serialized[0]) return null;
        return {
            tagName: String(serialized[0] || ''),
            digits: serialized[1] | 0
        };
    }

    function serializeIncludeEntries(includeEntries = [], getDefineRef) {
        return (includeEntries || [])
            .map(entry => serializeIncludeEntryWithDefineRefs(entry, getDefineRef))
            .filter(Boolean);
    }

    function serializeUnresolvedIncludeEntries(entries = []) {
        return (entries || [])
            .filter(entry => entry?.name)
            .map(entry => {
                const serialized = [
                    String(entry.name || ''),
                    Number.isInteger(entry.lineNumber) ? entry.lineNumber : -1,
                    Number.isInteger(entry.depth) ? entry.depth : 0
                ];
                if (entry.parentName) serialized[3] = String(entry.parentName || '');
                if (Number.isInteger(entry.parentLineNumber)) serialized[4] = entry.parentLineNumber;
                return serialized;
            });
    }

    function reviveUnresolvedIncludeEntry(serialized) {
        if (!Array.isArray(serialized) || !serialized[0]) return null;
        const lineNumber = Number.isInteger(serialized[1]) ? serialized[1] : -1;
        const depth = Number.isInteger(serialized[2]) ? serialized[2] : 0;
        return {
            name: String(serialized[0] || ''),
            lineNumber,
            depth,
            parentName: serialized[3] ? String(serialized[3]) : '',
            parentLineNumber: Number.isInteger(serialized[4]) ? serialized[4] : -1,
            required: true
        };
    }

    function reviveUnresolvedIncludeEntries(entries = []) {
        return Array.isArray(entries)
            ? entries.map(reviveUnresolvedIncludeEntry).filter(Boolean)
            : [];
    }

    function reviveIncludeEntry(serialized, defineRefTable = null) {
        if (!Array.isArray(serialized)) return null;
        const filePath = serialized[1] || '';
        if (Array.isArray(defineRefTable)) {
            const defineRef = Number.isInteger(serialized[2]) ? defineRefTable[serialized[2]] : null;
            const entry = {
                name: String(serialized[0] || ''),
                filePath,
                depth: Number.isInteger(serialized[3]) ? serialized[3] : 0,
                rationalState: reviveRationalState(serialized[4]),
                defineDecls: defineRef?.defineDecls || [],
                sourcePriority: Number.isFinite(serialized[5]) ? serialized[5] : undefined,
                sourcePath: serialized[6] ? String(serialized[6] || '') : '',
                resolutionKind: serialized[7] ? String(serialized[7] || '') : ''
            };
            return attachLazyDefineStateKey(
                entry,
                entry.defineDecls,
                getStoredDefineStateKeyWithoutComputing(defineRef)
            );
        }
        return {
            name: String(serialized[0] || ''),
            filePath,
            defineStateKey: String(serialized[2] || ''),
            depth: Number.isInteger(serialized[3]) ? serialized[3] : 0,
            defineDecls: reviveDefineDecls(serialized[4] || []),
            rationalState: reviveRationalState(serialized[5]),
            sourcePriority: Number.isFinite(serialized[6]) ? serialized[6] : undefined,
            sourcePath: serialized[7] ? String(serialized[7] || '') : '',
            resolutionKind: serialized[8] ? String(serialized[8] || '') : ''
        };
    }

    function getSerializedIncludeEntryFilePath(serialized) {
        return Array.isArray(serialized)
            ? serialized[1]
            : '';
    }

    function serializePreprocessedState(state, baseDefineDecls = null) {
        if (!state || typeof state !== 'object') return null;
        const defineRefs = createDefineStateRefTable();
        const serializedBaseDefineDecls = Array.isArray(baseDefineDecls)
            ? serializeDefineDecls(baseDefineDecls)
            : null;
        const serialized = {
            c: String(state.content || ''),
            q: state.rationalState?.tagName
                ? [
                    String(state.rationalState.tagName || ''),
                    state.rationalState.digits | 0
                ]
                : null,
            d: Array.isArray(state.directiveCandidateLines)
                ? state.directiveCandidateLines.filter(Number.isInteger)
                : [],
            i: serializeIncludeEntries(state.includeEntries || [], defineRefs.getRef),
            m: serializeUnresolvedIncludeEntries(state.unresolvedIncludeEntries || [])
        };
        const ownDefineRef = defineRefs.getRef(state.defineDecls || [], state.defineStateKey || '');
        if (defineRefs.rows.length) {
            serialized.u = serializeDefineStateDeltaTable(defineRefs.rows, serializedBaseDefineDecls);
            if (serializedBaseDefineDecls) serialized.b = 1;
        }
        if (ownDefineRef >= 0) serialized.r = ownDefineRef;
        return serialized;
    }

    function revivePreprocessedState(serializedState, baseDefineDecls = null) {
        if (!serializedState || typeof serializedState !== 'object') return null;
        const content = String(serializedState.c ?? '');
        if (serializedState.b && !Array.isArray(baseDefineDecls)) return null;
        const defineRefTable = Array.isArray(serializedState.u)
            ? reviveDefineStateDeltaTable(serializedState.u, serializedState.b ? baseDefineDecls : null)
            : null;
        const ownDefineRef = defineRefTable && Number.isInteger(serializedState.r)
            ? defineRefTable[serializedState.r]
            : null;
        const defineDecls = defineRefTable
            ? (ownDefineRef?.defineDecls || [])
            : [];
        const defineStateKey = defineRefTable
            ? getStoredDefineStateKeyWithoutComputing(ownDefineRef)
            : '';
        const revivedState = {
            content,
            rawLines: splitPawnLines(content),
            rationalState: reviveRationalState(serializedState.q),
            directiveCandidateLines: Array.isArray(serializedState.d)
                ? serializedState.d.filter(Number.isInteger)
                : [],
            includeEntries: Array.isArray(serializedState.i)
                ? serializedState.i
                    .map(entry => reviveIncludeEntry(entry, defineRefTable))
                    .filter(entry => entry && normalizeFsPath(entry.filePath))
                : [],
            unresolvedIncludeEntries: reviveUnresolvedIncludeEntries(serializedState.m),
            defineDecls: defineRefTable ? defineDecls : []
        };
        return attachLazyDefineStateKey(revivedState, revivedState.defineDecls, defineStateKey || '');
    }

    const reviveIncludeDeclCompactObject = serialized =>
        reviveCompactObject(serialized, INCLUDE_DECL_COMPACT_KEYS);

    return {
        INCLUDE_DECL_COMPACT_SIGNATURE,
        deserializeDependencyStamps,
        getSerializedIncludeEntryFilePath,
        reviveDefineDecls,
        reviveIncludeDeclCompactObject,
        revivePreprocessedState,
        serializeDependencyStamps,
        serializeDefineDecls,
        serializeIncludeDecls,
        serializePreprocessedState
    };
}

module.exports = { createIncludeCacheCodec };
