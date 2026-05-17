function createLinkedDefinitionCore(deps) {
    const {
        vscode,
        normalizeFsPath,
        isPawnDocument = null,
        getPawnDocumentContext,
        findFirstNavigableDecl
    } = deps;

    function getDocumentKey(document) {
        return normalizeFsPath(document?.fileName || '');
    }

    function isUsablePawnDocument(document) {
        if (!document?.fileName) return false;
        return typeof isPawnDocument === 'function' ? isPawnDocument(document) : true;
    }

    function collectOpenPawnDocuments(currentDocument) {
        const seen = new Set();
        const documents = [];
        const currentKey = getDocumentKey(currentDocument);
        const addDocument = document => {
            const key = getDocumentKey(document);
            if (!key || key === currentKey || seen.has(key) || !isUsablePawnDocument(document)) return;
            seen.add(key);
            documents.push(document);
        };

        for (const editor of vscode?.window?.visibleTextEditors || []) {
            addDocument(editor?.document);
        }
        for (const document of vscode?.workspace?.textDocuments || []) {
            addDocument(document);
        }

        return documents;
    }

    function contextIncludesFile(context, targetFilePath) {
        const targetKey = normalizeFsPath(targetFilePath || '');
        if (!targetKey) return false;
        for (const entry of context?.includeEntries || []) {
            if (normalizeFsPath(entry?.filePath || '') === targetKey) return true;
        }
        return false;
    }

    function findLinkedWorkspaceNavigableDecl(document, name) {
        if (!document?.fileName || !name || typeof getPawnDocumentContext !== 'function') return null;
        const currentFilePath = document.fileName;

        for (const candidateDocument of collectOpenPawnDocuments(document)) {
            let candidateContext = null;
            try {
                candidateContext = getPawnDocumentContext(candidateDocument, undefined, {
                    includeDecls: false
                });
            } catch {
                candidateContext = null;
            }
            if (!contextIncludesFile(candidateContext, currentFilePath)) continue;

            const targetDecl = findFirstNavigableDecl(candidateContext?.lookup, name);
            if (targetDecl?.filePath) return targetDecl;
        }

        return null;
    }

    return {
        collectOpenPawnDocuments,
        contextIncludesFile,
        findLinkedWorkspaceNavigableDecl
    };
}

module.exports = { createLinkedDefinitionCore };
