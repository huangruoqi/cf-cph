import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';
import { TestCase } from './types';
import { TEMPLATE } from './constants';
// import { saveProblem } from './parser';

const ILLEGAL_CHARS = /[<>\[\]?*|:]/g;

const parseHTML = async (url: string) => {
    const response = await fetch(url);
    const text = await response.text();
    return cheerio.load(text);
};

async function getContestInfo(contestId: string) {
    const url = `https://codeforces.com/contest/${contestId}?locale=en`;
    const $ = await parseHTML(url);
    // const result = {};
    const keys: string[] = [];
    const contestName = $(".rtable a").first().text().trim();
    $('.problems tr').slice(1).each((_, element) => {
        const problemId = $(element).find('.id a').text().trim();
        // const problemDesc = $(element).find('a').eq(1).text().trim();
        keys.push(problemId);
    });
    return { name: contestName, keys }
}

// async function getProblemInfo(contestId: string, problem: string) {
//     const url = `https://codeforces.com/contest/${contestId}/problem/${problem}?locale=en`
//     const response = await fetch(url);
//     const text = await response.text();
//     text
//     return { key: problem, testcases: [] as TestCase[] }
// }

async function createContestFolder(name: string, keys: string[]) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage("No workspace folder is open.");
        return;
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const safeContestName = name.replace(ILLEGAL_CHARS, '');
    const contestPath = path.join(workspacePath, safeContestName);

    if (fs.existsSync(contestPath)) {
        vscode.window.showErrorMessage(`Contest folder already exists: ${contestPath}`);
        const res = await vscode.window.showInputBox({ prompt: 'Enter `yes` to reinitialize...' });
        if (res !== 'yes') {
            return
        }
    }

    fs.rmdirSync(contestPath, { recursive: true });
    fs.mkdirSync(contestPath, { recursive: true });

    for (let i = 0; i < keys.length; i++) {
        const problemPath = path.join(contestPath, `${keys[i]}.py`);
        fs.writeFileSync(problemPath, TEMPLATE.replace("{contest}", name));
    }
}

export async function createContest() {
    const contestId = await vscode.window.showInputBox({ prompt: 'Enter Codeforces Contest ID' });
    if (contestId && contestId.trim()) {
        try {
            const { name, keys } = await getContestInfo(contestId);
            await createContestFolder(name, keys);
            vscode.window.showInformationMessage(`Contest <${name}> initialized`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to fetch contest data: ${error}`);
        }
    }
}