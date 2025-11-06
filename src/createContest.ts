import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Problem } from './types';
import {
    DEFAULT_MEMORY_LIMIT,
    DEFAULT_TIME_LIMIT,
    ILLEGAL_CHARS,
    TEMPLATE,
} from './constants';
import { saveProblem } from './parser';
import {
    startContestProblemCollection,
    stopContestProblemCollection,
    setProcessingContest,
} from './companion';

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

function getLAFmtTime() {
    const now = new Date().toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        hour12: false,
    });
    return now;
}

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch contest info using the official Codeforces API
 */
async function getContestInfo(contestId: string) {
    const apiUrl = `https://codeforces.com/api/contest.standings?contestId=${contestId}&from=1&count=1`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch contest info: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.status !== 'OK') {
        throw new Error(`Codeforces API error: ${data.comment}`);
    }

    const contestName = data.result.contest.name;
    const problems = data.result.problems;

    const result: Record<string, string> = {};
    for (const p of problems) {
        result[p.index] = p.name;
    }

    return { name: contestName, result };
}

/**
 * Convert Competitive Companion problem format to our Problem format
 */
function convertCompanionProblem(companionProblem: any): Problem {
    globalThis.logger.log(
        '[Convert Problem] Converting Competitive Companion problem:',
        companionProblem.name,
    );
    globalThis.logger.log(
        '[Convert Problem] Companion data:',
        JSON.stringify(companionProblem, null, 2),
    );

    // Map test cases from Competitive Companion format
    const tests = (companionProblem.tests || []).map(
        (test: any, index: number) => {
            globalThis.logger.log(
                `[Convert Problem] Test case ${index + 1}: input length=${
                    test.input?.length || 0
                }, output length=${test.output?.length || 0}`,
            );
            return {
                input: test.input || '',
                output: test.output || '',
                id: index,
                original: true,
            };
        },
    );

    const result: Problem = {
        name: companionProblem.name || '',
        url: companionProblem.url || '',
        interactive: companionProblem.interactive || false,
        memoryLimit: companionProblem.memoryLimit || DEFAULT_MEMORY_LIMIT,
        timeLimit: companionProblem.timeLimit || DEFAULT_TIME_LIMIT,
        group: companionProblem.group || 'local',
        tests: tests,
        srcPath: '',
    };

    globalThis.logger.log(
        `[Convert Problem] Converted problem: ${result.name} with ${result.tests.length} test cases`,
    );
    globalThis.logger.log(
        '[Convert Problem] Result:',
        JSON.stringify(result, null, 2),
    );

    return result;
}

function getWorkspacePath() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder is open.');
        return;
    }
    return workspaceFolders[0].uri.fsPath;
}

async function createContestFolderFromCompanion(
    _contestId: string,
    name: string,
    problems: Problem[],
    _problemIndices: Record<string, string>,
) {
    const workspacePath = getWorkspacePath();
    if (workspacePath === undefined) {
        return;
    }
    const safeContestName = name.replace(ILLEGAL_CHARS, '');
    const contestPath = path.join(workspacePath, safeContestName);

    if (fs.existsSync(contestPath)) {
        vscode.window.showErrorMessage(
            `Contest folder already exists: ${contestPath}`,
        );
        const res = await vscode.window.showInputBox({
            prompt: 'Enter `yes` to reinitialize...',
        });
        if (res !== 'yes') {
            return;
        }
        fs.rmdirSync(contestPath, { recursive: true });
    }

    vscode.window.showInformationMessage(
        `Creating <${safeContestName}> folder`,
    );
    fs.mkdirSync(contestPath, { recursive: true });

    const timeString = getLAFmtTime();

    globalThis.logger.log(
        `[Create Contest Folder] Creating folder with ${problems.length} problems`,
    );
    globalThis.logger.log(
        `[Create Contest Folder] Problems: ${problems
            .map((p) => `${p.name} (${p.url})`)
            .join(', ')}`,
    );

    // Sort problems by their index (A, B, C, etc.)
    // If URL doesn't have index, try to extract from problem name or use alphabetical order
    const sortedProblems = problems.sort((a, b) => {
        // Extract problem index from URL (e.g., /problem/A, /problem/B)
        const getIndex = (url: string, name: string): string => {
            const urlMatch = url.match(/\/problem\/([A-Z])/);
            if (urlMatch) {
                return urlMatch[1];
            }
            // Try to extract from name (e.g., "A. Problem Name" -> "A")
            const nameMatch = name.match(/^([A-Z])\.?\s/);
            if (nameMatch) {
                return nameMatch[1];
            }
            return '';
        };
        const indexA = getIndex(a.url, a.name);
        const indexB = getIndex(b.url, b.name);
        if (indexA && indexB) {
            return indexA.localeCompare(indexB);
        }
        // If no index, sort alphabetically by name
        return a.name.localeCompare(b.name);
    });

    globalThis.logger.log(
        `[Create Contest Folder] Sorted problems: ${sortedProblems
            .map((p) => p.name)
            .join(', ')}`,
    );

    for (const problem of sortedProblems) {
        // Extract problem index from URL (e.g., /problem/A -> A)
        let urlMatch = problem.url.match(/\/problem\/([A-Z])/);
        let problemIndex = urlMatch ? urlMatch[1] : '';

        // If no index from URL, try to extract from problem name (e.g., "A. Problem Name")
        if (!problemIndex) {
            const nameMatch = problem.name.match(/^([A-Z])\.?\s/);
            if (nameMatch) {
                problemIndex = nameMatch[1];
            } else {
                // Fallback: use first letter of problem name or sequential letter
                problemIndex = problem.name.charAt(0).toUpperCase();
                if (!/^[A-Z]$/.test(problemIndex)) {
                    // Use sequential letters if name doesn't start with A-Z
                    const index = sortedProblems.indexOf(problem);
                    problemIndex = String.fromCharCode(65 + index); // A, B, C, etc.
                }
            }
        }

        if (!problemIndex) {
            problemIndex = 'X';
        }

        globalThis.logger.log(
            `[Create Contest Folder] Creating problem ${problem.name} with index ${problemIndex}`,
        );

        const problemPath = path.join(contestPath, `${problemIndex}.py`);
        fs.writeFileSync(
            problemPath,
            TEMPLATE.replace('{contest}', name)
                .replace('{time}', timeString)
                .replace('{problem}', problem.name),
        );

        problem.srcPath = problemPath;
        saveProblem(problemPath, problem);
        vscode.window.showInformationMessage(
            `Problem <${problem.name}> (${problemIndex}) created`,
        );
    }

    await wait(100);
    return contestPath;
}

export async function createContest() {
    const contestId = await vscode.window.showInputBox({
        prompt: 'Enter Codeforces Contest ID',
    });
    if (contestId && contestId.trim()) {
        try {
            const { name, result } = await getContestInfo(contestId);
            const expectedCount = Object.keys(result).length;

            // Show detailed instructions to user
            const instructions = [
                `Contest: ${name}`,
                `Expected problems: ${expectedCount}`,
                ``,
                `📋 INSTRUCTIONS:`,
                `1. Open: https://codeforces.com/contest/${contestId}/problems`,
                `2. Click Competitive Companion icon on each problem (A, B, C, etc.)`,
                `3. VS Code will collect problems automatically`,
                ``,
                `⏳ Waiting for ${expectedCount} problems...`,
            ].join('\n');

            // Show instructions in a more prominent way
            await vscode.window.showInformationMessage(instructions, {
                modal: false,
            });

            // Also show a status bar message
            vscode.window.setStatusBarMessage(
                `Waiting for ${expectedCount} problems from Competitive Companion...`,
                30000,
            );

            // Start collecting problems from Competitive Companion
            globalThis.logger.log(
                `[Create Contest] Starting collection for contest ${contestId}, expecting ${expectedCount} problems`,
            );

            const companionProblems = await startContestProblemCollection(
                contestId,
                expectedCount,
            );

            globalThis.logger.log(
                `[Create Contest] Collection complete. Received ${companionProblems.length} problems`,
            );
            globalThis.logger.log(
                `[Create Contest] Received problems:`,
                companionProblems.map((p) => `${p.name} (${p.url})`).join(', '),
            );

            // Mark that we're processing the contest to prevent race conditions
            // This prevents any late-arriving problems from creating files
            setProcessingContest(true);

            if (companionProblems.length === 0) {
                vscode.window.showErrorMessage(
                    'No problems received from Competitive Companion. Please make sure you have the extension installed and click on problem pages.',
                );
                stopContestProblemCollection();
                return;
            }

            // Convert Competitive Companion format to our Problem format
            globalThis.logger.log(
                '[Create Contest] Converting problems to internal format',
            );
            const problems = companionProblems.map(
                (companionProblem, index) => {
                    globalThis.logger.log(
                        `[Create Contest] Converting problem ${index + 1}: ${
                            companionProblem.name
                        }`,
                    );
                    const converted = convertCompanionProblem(companionProblem);
                    globalThis.logger.log(
                        `[Create Contest] Converted problem has ${converted.tests.length} test cases`,
                    );
                    return converted;
                },
            );

            if (problems.length < expectedCount) {
                const proceed = await vscode.window.showWarningMessage(
                    `Only received ${problems.length} out of ${expectedCount} problems. Continue anyway?`,
                    'Yes',
                    'No',
                );
                if (proceed !== 'Yes') {
                    stopContestProblemCollection();
                    return;
                }
            }

            const workspacePath = getWorkspacePath();
            if (workspacePath === undefined) {
                stopContestProblemCollection();
                return;
            }

            globalThis.logger.log(
                `[Create Contest] About to create contest folder with ${problems.length} problems`,
            );
            globalThis.logger.log(
                `[Create Contest] Problems to create: ${problems
                    .map((p) => p.name)
                    .join(', ')}`,
            );

            closeAllFiles();
            const contestPath = await createContestFolderFromCompanion(
                contestId,
                name,
                problems,
                result,
            );

            globalThis.logger.log(
                `[Create Contest] Contest folder created at: ${contestPath}`,
            );

            if (contestPath) {
                // Open all problem files
                const paths: string[] = [];
                for (const problem of problems) {
                    if (problem.srcPath) {
                        paths.push(problem.srcPath);
                    }
                }

                const promises = paths.map((path) => openFileLocked(path));
                await Promise.all(promises);
                if (paths.length > 0) {
                    openFileLocked(paths[0]);
                }

                vscode.window.showInformationMessage(
                    `Contest <${name}> initialized with ${problems.length} problems`,
                );
            }

            stopContestProblemCollection();
        } catch (error) {
            stopContestProblemCollection();
            vscode.window.showErrorMessage(
                `Failed to fetch contest data: ${error}`,
            );
        }
    }
}
