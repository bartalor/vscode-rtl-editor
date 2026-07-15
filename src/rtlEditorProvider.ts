import * as vscode from 'vscode';
import * as path from 'path';

type DiffHunk = {
    // 1-based line numbers in the current (modified) document
    startLine: number;
    endLine: number;
    kind: 'added' | 'modified' | 'deleted';
};

export class RtlEditorProvider implements vscode.CustomTextEditorProvider {
    private static readonly viewType = 'rtl-editor.rtlTextEditor';

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new RtlEditorProvider(context);
        const providerRegistration = vscode.window.registerCustomEditorProvider(
            RtlEditorProvider.viewType,
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                    enableFindWidget: true
                },
                supportsMultipleEditorsPerDocument: false
            }
        );
        return providerRegistration;
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        // Setup initial content for the webview
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media')
            ]
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document);

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'edit':
                    await this.applyEdit(document, message.start, message.end, message.text);
                    break;
                case 'undo':
                    await vscode.commands.executeCommand('undo');
                    break;
                case 'redo':
                    await vscode.commands.executeCommand('redo');
                    break;
                case 'save':
                    await document.save();
                    webviewPanel.webview.postMessage({
                        type: 'saveSuccess',
                        message: 'File saved successfully'
                    });
                    break;
                case 'refresh':
                    this.refreshFromDisk(document, webviewPanel.webview);
                    break;
                case 'refreshWithDraft':
                    // Refresh but keep user's draft content for comparison
                    this.refreshWithDraftContent(document, webviewPanel.webview, message.draftContent);
                    break;
                case 'openDiff':
                    await this.openGitDiff(document);
                    break;
            }
        });

        let diffTimer: NodeJS.Timeout | undefined;
        const scheduleDiffUpdate = () => {
            if (diffTimer) {
                clearTimeout(diffTimer);
            }
            diffTimer = setTimeout(() => this.sendDiff(document, webviewPanel.webview), 200);
        };

        // Handle text document changes
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                this.updateWebview(webviewPanel.webview, document);
                scheduleDiffUpdate();
            }
        });

        const saveSubscription = vscode.workspace.onDidSaveTextDocument(doc => {
            if (doc.uri.toString() === document.uri.toString()) {
                scheduleDiffUpdate();
            }
        });

        // Watch for external file changes - use a more reliable pattern
        const fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
                vscode.Uri.file(path.dirname(document.uri.fsPath)),
                path.basename(document.uri.fsPath)
            ),
            true, // ignore creates
            false, // watch changes
            true // ignore deletes
        );

        fileWatcher.onDidChange(async () => {
            try {
                const fileContent = await vscode.workspace.fs.readFile(document.uri);
                const diskContent = Buffer.from(fileContent).toString('utf8');

                if (diskContent === document.getText()) {
                    return;
                }

                webviewPanel.webview.postMessage({
                    type: 'fileChanged',
                    message: 'File has been modified externally. Click Refresh to reload or continue editing.',
                    hasUnsavedChanges: true
                });
            } catch (error) {
                console.error('Error checking external file change:', error);
            }
        });

        // Clean up
        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
            saveSubscription.dispose();
            fileWatcher.dispose();
            if (diffTimer) {
                clearTimeout(diffTimer);
            }
        });

        // Initial content update
        this.updateWebview(webviewPanel.webview, document);
        scheduleDiffUpdate();
    }

    private async getHeadContent(document: vscode.TextDocument): Promise<string | undefined> {
        try {
            const gitExtension = vscode.extensions.getExtension<any>('vscode.git');
            if (!gitExtension) {
                return undefined;
            }
            const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
            const api = git.getAPI(1);
            const repo = api.getRepository(document.uri);
            if (!repo) {
                return undefined;
            }
            // 'HEAD' returns the content of the file at HEAD (or empty for untracked).
            return await repo.show('HEAD', document.uri.fsPath);
        } catch {
            // Untracked files, no HEAD (fresh repo), etc.
            return undefined;
        }
    }

    private async sendDiff(document: vscode.TextDocument, webview: vscode.Webview): Promise<void> {
        const head = await this.getHeadContent(document);
        if (head === undefined) {
            webview.postMessage({ type: 'diff', hunks: [], available: false });
            return;
        }
        const hunks = computeLineDiff(head, document.getText());
        webview.postMessage({ type: 'diff', hunks, available: true });
    }

    private async openGitDiff(document: vscode.TextDocument): Promise<void> {
        try {
            const gitExtension = vscode.extensions.getExtension<any>('vscode.git');
            if (!gitExtension) {
                vscode.window.showInformationMessage('Git extension is not available.');
                return;
            }
            const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
            const api = git.getAPI(1);
            const repo = api.getRepository(document.uri);
            if (!repo) {
                vscode.window.showInformationMessage('File is not in a git repository.');
                return;
            }
            // Build the git: URI VS Code uses for HEAD content.
            const headUri = document.uri.with({
                scheme: 'git',
                path: document.uri.path,
                query: JSON.stringify({ path: document.uri.fsPath, ref: 'HEAD' })
            });
            const title = `${path.basename(document.uri.fsPath)} (HEAD ↔ Working Tree)`;
            await vscode.commands.executeCommand('vscode.diff', headUri, document.uri, title);
        } catch (err) {
            vscode.window.showErrorMessage('Failed to open diff: ' + (err instanceof Error ? err.message : String(err)));
        }
    }

    private async applyEdit(document: vscode.TextDocument, start: number, end: number, text: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(document.positionAt(start), document.positionAt(end)),
            text
        );
        await vscode.workspace.applyEdit(edit);
    }

    private updateWebview(webview: vscode.Webview, document: vscode.TextDocument): void {
        webview.postMessage({
            type: 'update',
            content: document.getText()
        });
    }

    private async refreshFromDisk(document: vscode.TextDocument, webview: vscode.Webview): Promise<void> {
        try {
            // Force reload the document from disk
            const fileContent = await vscode.workspace.fs.readFile(document.uri);
            const textContent = Buffer.from(fileContent).toString('utf8');
            
            webview.postMessage({
                type: 'refreshComplete',
                content: textContent
            });
        } catch (error) {
            webview.postMessage({
                type: 'refreshError',
                message: 'Failed to refresh file: ' + (error instanceof Error ? error.message : 'Unknown error')
            });
        }
    }

    private async refreshWithDraftContent(document: vscode.TextDocument, webview: vscode.Webview, draftContent: string): Promise<void> {
        try {
            // Get the current file content from disk
            const fileContent = await vscode.workspace.fs.readFile(document.uri);
            const diskContent = Buffer.from(fileContent).toString('utf8');
            
            // Send both contents to webview for user to decide
            webview.postMessage({
                type: 'showMergeDialog',
                diskContent: diskContent,
                draftContent: draftContent,
                message: 'File was modified externally. Choose which version to keep:'
            });
        } catch (error) {
            webview.postMessage({
                type: 'refreshError',
                message: 'Failed to compare file versions: ' + (error instanceof Error ? error.message : 'Unknown error')
            });
        }
    }

    private getHtmlForWebview(webview: vscode.Webview, document: vscode.TextDocument): string {
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.js')
        );

        // Get current content
        const content = document.getText();
        const fileName = path.basename(document.uri.fsPath);

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};">
            <title>RTL Editor - ${fileName}</title>
            <link rel="stylesheet" href="${styleUri}">
        </head>
        <body>
            <div id="notification-bar" class="notification-bar hidden">
                <span id="notification-message"></span>
                <button id="notification-refresh" class="btn btn-small">Refresh</button>
                <button id="notification-dismiss" class="btn btn-small">×</button>
            </div>
            
            <div class="editor-container">
                <div class="editor-wrapper">
                    <textarea id="editor" class="rtl-editor" placeholder="Start typing in RTL mode...">${this.escapeHtml(content)}</textarea>
                    <div id="line-numbers" class="line-numbers"></div>
                    <div id="diff-gutter" class="diff-gutter" title="Click a marker to open the diff view"></div>
                    <div id="line-mirror" class="line-mirror"></div>
                </div>
            </div>
            
            <script src="${scriptUri}"></script>
        </body>
        </html>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}

// Line-based diff producing hunks referencing lines in the modified text.
// Uses classic LCS. Files edited in this custom editor are text documents
// intended for human editing, so line counts stay small enough for O(n*m).
export function computeLineDiff(oldText: string, newText: string): DiffHunk[] {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const n = oldLines.length;
    const m = newLines.length;

    // LCS length table
    const dp: Uint32Array[] = new Array(n + 1);
    for (let i = 0; i <= n; i++) {
        dp[i] = new Uint32Array(m + 1);
    }
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            if (oldLines[i] === newLines[j]) {
                dp[i][j] = dp[i + 1][j + 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
    }

    // Walk table to produce edit script
    type Op = { kind: 'eq' | 'del' | 'ins'; newLine?: number };
    const ops: Op[] = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (oldLines[i] === newLines[j]) {
            ops.push({ kind: 'eq', newLine: j + 1 });
            i++; j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            ops.push({ kind: 'del', newLine: j + 1 }); // deletion at position before newLine
            i++;
        } else {
            ops.push({ kind: 'ins', newLine: j + 1 });
            j++;
        }
    }
    while (i < n) {
        ops.push({ kind: 'del', newLine: j + 1 });
        i++;
    }
    while (j < m) {
        ops.push({ kind: 'ins', newLine: j + 1 });
        j++;
    }

    // Merge adjacent ops into hunks. A run of ins+del touching the same line
    // range becomes 'modified'; pure ins is 'added'; pure del is 'deleted'.
    const hunks: DiffHunk[] = [];
    let k = 0;
    while (k < ops.length) {
        if (ops[k].kind === 'eq') { k++; continue; }
        let hasIns = false, hasDel = false;
        let firstNewLine = ops[k].newLine!;
        let lastNewLine = firstNewLine;
        while (k < ops.length && ops[k].kind !== 'eq') {
            if (ops[k].kind === 'ins') {
                hasIns = true;
                lastNewLine = ops[k].newLine!;
            } else {
                hasDel = true;
            }
            k++;
        }
        if (hasIns && hasDel) {
            hunks.push({ kind: 'modified', startLine: firstNewLine, endLine: lastNewLine });
        } else if (hasIns) {
            hunks.push({ kind: 'added', startLine: firstNewLine, endLine: lastNewLine });
        } else {
            // Pure deletion: mark on the line immediately after the deletion point.
            const marker = Math.min(Math.max(firstNewLine, 1), Math.max(m, 1));
            hunks.push({ kind: 'deleted', startLine: marker, endLine: marker });
        }
    }
    return hunks;
}