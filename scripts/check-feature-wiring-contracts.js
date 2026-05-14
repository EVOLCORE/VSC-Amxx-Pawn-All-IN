const fs = require('fs');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function readText(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

function readFactoryRequiredDeps(filePath, factoryName) {
    const text = readText(filePath);
    const functionStart = text.indexOf(`function ${factoryName}(deps)`);
    assert(functionStart >= 0, `${factoryName}: factory function not found`);
    const body = text.slice(functionStart);
    const match = body.match(/const\s*\{([\s\S]*?)\}\s*=\s*deps\s*;/);
    assert(match, `${factoryName}: deps destructuring not found`);

    const required = [];
    for (const rawPart of match[1].split(',')) {
        const part = rawPart.trim();
        if (!part || part.includes('=')) continue;
        const name = part.match(/^([A-Za-z_$][\w$]*)\b/)?.[1] || '';
        if (name) required.push(name);
    }
    return required;
}

function findCallObjectBody(text, callName) {
    const callStart = text.indexOf(`${callName}({`);
    assert(callStart >= 0, `${callName}: wiring call not found`);
    const objectStart = text.indexOf('{', callStart);
    let depth = 0;
    for (let index = objectStart; index < text.length; index++) {
        const char = text[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return text.slice(objectStart + 1, index);
            }
        }
    }
    throw new Error(`${callName}: wiring object did not close`);
}

function readProvidedDeps(filePath, callName) {
    const body = findCallObjectBody(readText(filePath), callName);
    const provided = new Set();
    for (const rawPart of body.split(',')) {
        const part = rawPart.trim();
        if (!part) continue;
        const name = part.match(/^([A-Za-z_$][\w$]*)\s*:/)?.[1] ||
            part.match(/^([A-Za-z_$][\w$]*)\b/)?.[1] ||
            '';
        if (name) provided.add(name);
    }
    return provided;
}

function checkContract({ factoryFile, factoryName, wiringFile, callName = factoryName, allowedMissing = [], expectedProvided = [] }) {
    const required = readFactoryRequiredDeps(factoryFile, factoryName);
    const provided = readProvidedDeps(wiringFile, callName);
    const allowed = new Set(allowedMissing);
    const missing = required.filter(name => !provided.has(name) && !allowed.has(name));
    assert(
        missing.length === 0,
        `${factoryName}: missing wiring deps: ${missing.join(', ')}`
    );
    const missingExpected = expectedProvided.filter(name => !provided.has(name));
    assert(
        missingExpected.length === 0,
        `${factoryName}: missing expected wiring deps: ${missingExpected.join(', ')}`
    );
    return `${factoryName}: pass`;
}

function main() {
    const checks = [
        {
            factoryFile: 'features/live-validation/diagnostics.js',
            factoryName: 'createLiveValidationDiagnosticCore',
            wiringFile: 'bootstrap/feature-wiring/live-validation.js',
            callName: 'createLiveValidationModule'
        },
        {
            factoryFile: 'features/editor-lifecycle/index.js',
            factoryName: 'createEditorLifecycleFeature',
            wiringFile: 'bootstrap/feature-wiring/editor-lifecycle.js',
            expectedProvided: ['getLiveValidationTypingDelayMs']
        },
        {
            factoryFile: 'features/hover/factory.js',
            factoryName: 'createHoverRuntimeFeature',
            wiringFile: 'bootstrap/feature-wiring/hover.js',
            allowedMissing: [
                'buildStructuredEnumFieldHover',
                'resolveArgumentSymbolName',
                'applyHoverDisplayNameSuffixToMatches',
                'isHoverAtActiveCursor'
            ]
        },
        {
            factoryFile: 'features/persistent-hover/index.js',
            factoryName: 'createPersistentHoverFeature',
            wiringFile: 'bootstrap/feature-wiring/hover.js'
        },
        {
            factoryFile: 'features/completion/index.js',
            factoryName: 'createCompletionFeature',
            wiringFile: 'bootstrap/feature-wiring/completion-navigation.js'
        },
        {
            factoryFile: 'features/navigation/index.js',
            factoryName: 'createNavigationFeature',
            wiringFile: 'bootstrap/feature-wiring/completion-navigation.js'
        },
        {
            factoryFile: 'features/rename/index.js',
            factoryName: 'createRenameFeature',
            wiringFile: 'bootstrap/feature-wiring/completion-navigation.js'
        },
        {
            factoryFile: 'services/document-language.js',
            factoryName: 'createDocumentLanguageService',
            wiringFile: 'bootstrap/feature-wiring/support.js'
        },
        {
            factoryFile: 'features/theme-recommendation/index.js',
            factoryName: 'createThemeRecommendationFeature',
            wiringFile: 'bootstrap/feature-wiring/support.js'
        },
        {
            factoryFile: 'services/command-links.js',
            factoryName: 'createCommandLinkService',
            wiringFile: 'bootstrap/feature-wiring/support.js'
        }
    ];

    for (const check of checks) {
        console.log(checkContract(check));
    }
    console.log('feature-wiring-contracts: pass');
}

main();
