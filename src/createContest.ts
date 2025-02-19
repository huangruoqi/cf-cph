import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export async function createContestFolder(contestId: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage("No workspace folder is open.");
        return;
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const contestPath = path.join(workspacePath, `contest_${contestId}`);

    if (fs.existsSync(contestPath)) {
        vscode.window.showErrorMessage(`Contest folder already exists: ${contestPath}`);
        return;
    }

    fs.mkdirSync(contestPath, { recursive: true });

    const url = `https://codeforces.com/contest/${contestId}?locale=en`;
    try {
        const response = await fetch(url);
        const text = await response.text();
        const problemRegex = /<td class="id">\s*<a[^>]*>([A-Z]\d*)<\/a>\s*<\/td>\s*<td>\s*<a[^>]*>([^<]+)<\/a>/g;
        let match;
        const problems: { [key: string]: string } = {};
        
        while ((match = problemRegex.exec(text)) !== null) {
            problems[match[1]] = match[2];
        }
        
        for (const [id, name] of Object.entries(problems)) {
            const problemPath = path.join(contestPath, `${id}.txt`);
            fs.writeFileSync(problemPath, `Problem: ${name}\nURL: https://codeforces.com/contest/${contestId}/problem/${id}`);
        }
        
        vscode.window.showInformationMessage(`Contest ${contestId} initialized.`);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to fetch contest data: ${error}`);
    }
}

export async function createContest() {
    const contestId = await vscode.window.showInputBox({ prompt: 'Enter Codeforces Contest ID' });
    if (contestId) {
        await createContestFolder(contestId);
    }
}