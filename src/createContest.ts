import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';
import { Problem } from './types';
import { DEFAULT_MEMORY_LIMIT, DEFAULT_TIME_LIMIT, ILLEGAL_CHARS, TEMPLATE } from './constants';
import { saveProblem } from './parser';

export function closeAllFiles() {
    vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function openFileLocked(filePath: string) {
    try {
        const uri = vscode.Uri.file(filePath); // Convert to a URI
        const document = await vscode.workspace.openTextDocument(uri); // Open the file
        await vscode.window.showTextDocument(document, { preview: false }); // Lock tab
    } catch (error) {
        vscode.window.showErrorMessage(`Error opening file: ${error}`);
    }
}

const parseHTML = async (url: string) => {
    const proxy = "https://api.allorigins.win/raw?url=";
    const response = await fetch(proxy + encodeURIComponent(url), {
        headers: {
            "Accept": "text/html",
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.statusText}`);
    }
    const text = await response.text();
    return cheerio.load(text);
};

function getLAFmtTime() {
    const now = new Date().toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        hour12: false // 24-hour format; change to true for AM/PM
    });
    return now;
}

const parseMiliseconds = (time: string) => {
    const words = time.split(' ')
    if (words.length < 2) {
        return DEFAULT_TIME_LIMIT;
    }
    if (['seconds', 'second'].includes(words[1])) {
        return Math.floor(parseFloat(words[0]) * 1000);
    }
    return DEFAULT_TIME_LIMIT;
}

const parseMegabytes = (memory: string) => {
    const words = memory.split(' ')
    if (words.length < 2) {
        return DEFAULT_MEMORY_LIMIT;
    }
    if (['megabytes', 'megabyte'].includes(words[1])) {
        return Math.floor(parseFloat(words[0]));
    }
    return DEFAULT_MEMORY_LIMIT;
}

function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getContestInfo(contestId: string) {
    const url = `https://codeforces.com/contest/${contestId}`;
    const $ = await parseHTML(url);
    const result: Record<string, string> = {};
    const contestName = $(".rtable a").first().text().trim();
    $('.problems tr').slice(1).each((_, element) => {
        const problemId = $(element).find('.id a').text().trim();
        const problemDesc = $(element).find('a').eq(1).text().trim();
        result[problemId] = problemDesc;
    });
    return { name: contestName, result }
}

async function getProblemInfo(contestId: string, problem: string, name: string) {
    const url = `https://codeforces.com/contest/${contestId}/problem/${problem}`
    const $ = await parseHTML(url);
    const result: Problem = {
        name: name,
        url: url,
        interactive: false,
        memoryLimit: parseMegabytes($('.memory-limit').first().text()),
        timeLimit: parseMiliseconds($('.time-limit').first().text()),
        group: 'local',
        tests: [],
        srcPath: ''
    }
    const inputList: string[] = [];
    const outputList: string[] = [];

    // Extract inputs
    $(".input").each((_, a) => {
        const w = $(a).find(".test-example-line");
        if (w.length) {
            let ss: string[] = [];
            w.each((_, b) => {
                ss.push($(b).text(), "\n");
            });
            inputList.push(ss.join(""));
        } else {
            const w = $(a).find("pre").first();
            if (w.length) {
                const s = w.html()
                    ?.replace(/<br\s*\/?>/g, "\n")
                    .replace(/<\/?pre>/g, "")
                    .trim();
                inputList.push(s as string);
            }
        }
    });

    // Extract outputs
    $(".output").each((_, a) => {
        $(a).find("pre").each((_, b) => {
            const s = $(b).html()
                ?.replace(/<br\s*\/?>/g, "\n")
                .replace(/<\/?pre>/g, "")
                .trim();
            outputList.push(s as string);
        });
    });
    result.tests = inputList.map((input, i) => ({
        input,
        output: outputList[i],
        id: i,
        original: true,
    }));
    return result;
}

function getWorkspacePath() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage("No workspace folder is open.");
        return;
    }

    return workspaceFolders[0].uri.fsPath;
}

async function createContestFolder(contestId: string, name: string, result: Record<string, string>) {
    const workspacePath = getWorkspacePath();
    if (workspacePath === undefined) {
        return;
    }
    const safeContestName = name.replace(ILLEGAL_CHARS, '');
    const contestPath = path.join(workspacePath, safeContestName);

    if (fs.existsSync(contestPath)) {
        vscode.window.showErrorMessage(`Contest folder already exists: ${contestPath}`);
        const res = await vscode.window.showInputBox({ prompt: 'Enter `yes` to reinitialize...' });
        if (res !== 'yes') {
            return
        }
        fs.rmdirSync(contestPath, { recursive: true });
    }

    vscode.window.showInformationMessage(`Creating <${safeContestName}> folder`);
    fs.mkdirSync(contestPath, { recursive: true });

    const keys = Array.from(Object.keys(result));
    const timeString = getLAFmtTime();
    for (let i = 0; i < keys.length; i++) {
        await wait(1000);
        const problemPath = path.join(contestPath, `${keys[i]}.py`);
        fs.writeFileSync(
            problemPath,
            TEMPLATE
                .replace("{contest}", name)
                .replace("{time}", timeString)
                .replace("{problem}", result[keys[i]])
        );
        const problemName = result[keys[i]];
        const problem = await getProblemInfo(contestId, keys[i], problemName);
        problem.srcPath = problemPath;
        saveProblem(problemPath, problem);
        vscode.window.showInformationMessage(`Problem <${problemName}> created`);
    }
    await wait(100);
}

export async function createContest() {
    const contestId = await vscode.window.showInputBox({ prompt: 'Enter Codeforces Contest ID' });
    if (contestId && contestId.trim()) {
        try {
            const { name, result } = await getContestInfo(contestId);
            const workspacePath = getWorkspacePath();
            if (workspacePath === undefined) {
                return;
            }
            const safeContestName = name.replace(ILLEGAL_CHARS, '');
            const contestPath = path.join(workspacePath, safeContestName);
            closeAllFiles();
            await createContestFolder(contestId, name, result);
            const paths = [];
            for (let key of Object.keys(result)) {
                paths.push(path.join(contestPath, `${key}.py`));
            }
            const promises = [];
            for (let i = 0; i < paths.length; i++) {
                promises.push(openFileLocked(paths[i]));
            }
            await Promise.all(promises);
            openFileLocked(paths[0]);
            vscode.window.showInformationMessage(`Contest <${name}> initialized`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to fetch contest data: ${error}`);
        }
    }
}