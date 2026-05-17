const COMPILER_BUILTIN_SPECS = [
    {
        name: 'sizeof',
        args: 'symbol',
        kind: 'operator',
        docsKey: 'builtin.sizeof.docs'
    },
    {
        name: 'true',
        typeTag: 'bool',
        value: '1',
        kind: 'boolean',
        docsKey: 'builtin.true.docs'
    },
    {
        name: 'false',
        typeTag: 'bool',
        value: '0',
        kind: 'boolean',
        docsKey: 'builtin.false.docs'
    },
    {
        name: 'cellmin',
        kind: 'numeric',
        docsKey: 'builtin.cellmin.docs'
    },
    {
        name: 'cellmax',
        kind: 'numeric',
        docsKey: 'builtin.cellmax.docs'
    },
    {
        name: 'EOS',
        value: '0',
        kind: 'numeric'
    },
    {
        name: '__BINARY__',
        dims: '[]',
        kind: 'string',
        predefinedConstant: true,
        docsKey: 'builtin.__BINARY__.docs'
    },
    {
        name: '__FILE__',
        dims: '[]',
        kind: 'string',
        predefinedConstant: true,
        docsKey: 'builtin.__FILE__.docs'
    },
    {
        name: '__LINE__',
        kind: 'numeric',
        predefinedConstant: true,
        docsKey: 'builtin.__LINE__.docs'
    }
];

const COMPILER_BUILTIN_NAMES = new Set(COMPILER_BUILTIN_SPECS.map(spec => spec.name));
const COMPILER_PREDEFINED_CONSTANT_NAMES = new Set(
    COMPILER_BUILTIN_SPECS
        .filter(spec => spec.predefinedConstant)
        .map(spec => spec.name)
);

function createCompilerBuiltinDecls(t = key => key) {
    return COMPILER_BUILTIN_SPECS.map(spec => ({
        name: spec.name,
        args: spec.args || '',
        type: 'builtin',
        typeTag: spec.typeTag || '',
        modifiers: [],
        dims: spec.dims || '',
        file: '',
        filePath: '',
        lineNumber: 0,
        value: spec.value || '',
        builtinKind: spec.kind || '',
        docs: spec.docsKey ? t(spec.docsKey) : ''
    }));
}

function getCompilerBuiltinTypeInfo(decl) {
    if (!decl || decl.type !== 'builtin') return null;
    return {
        tag: decl.typeTag || '',
        dims: decl.dims || '',
        elementTag: decl.builtinKind === 'string' ? '_' : ''
    };
}

function isCompilerBuiltinName(name) {
    return COMPILER_BUILTIN_NAMES.has(String(name || ''));
}

function isCompilerPredefinedConstantName(name) {
    return COMPILER_PREDEFINED_CONSTANT_NAMES.has(String(name || ''));
}

module.exports = {
    COMPILER_BUILTIN_SPECS,
    createCompilerBuiltinDecls,
    getCompilerBuiltinTypeInfo,
    isCompilerBuiltinName,
    isCompilerPredefinedConstantName
};
