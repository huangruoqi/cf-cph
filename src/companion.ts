import http from 'http';
import config from './config';
import { Problem, CphSubmitResponse, CphEmptyResponse } from './types';
import { saveProblem } from './parser';
import * as vscode from 'vscode';
import path from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { isCodeforcesUrl, randomId } from './utils';
import {
    getDefaultLangPref,
    getLanguageId,
    useShortCodeForcesName,
    getMenuChoices,
    getDefaultLanguageTemplateFileLocation,
} from './preferences';
import { DEFAULT_MEMORY_LIMIT, DEFAULT_TIME_LIMIT } from './constants';
import { getProblemName } from './submit';
import { spawn } from 'child_process';
import { getJudgeViewProvider } from './extension';
import { words_in_text } from './utilsPure';
import telmetry from './telmetry';
import os from 'os';

const emptyResponse: CphEmptyResponse = { empty: true };
let savedResponse: CphEmptyResponse | CphSubmitResponse = emptyResponse;
const COMPANION_LOGGING = false;

// Store problems received from Competitive Companion for contest creation
// Note: For contest collection, we store raw Competitive Companion format (not converted Problem)
let contestProblemsStore: Map<string, any[]> = new Map();
let contestCreationListener: ((problem: any) => void) | null = null;
// Track if we're in the middle of processing a contest collection
// This prevents race conditions where problems might arrive during processing
let isProcessingContest = false;

/**
 * Queue manager to ensure sequential processing of problems from the same contest.
 * Prevents race conditions when multiple problems arrive concurrently.
 */
class ContestProcessingQueue {
    private queues: Map<string, Promise<void>> = new Map();

    /**
     * Queue a problem for processing. If a problem from the same contest is already
     * being processed, this will wait for it to complete before processing.
     */
    async queue(
        contestId: string,
        processFn: () => Promise<void>,
    ): Promise<void> {
        const previousPromise = this.queues.get(contestId) || Promise.resolve();

        const currentPromise = previousPromise
            .then(async () => {
                await processFn();
            })
            .catch((error) => {
                globalThis.logger.error(
                    `[Contest Queue] Error processing problem for contest ${contestId}:`,
                    error,
                );
            });

        this.queues.set(contestId, currentPromise);

        // Clean up queue entry after processing completes
        currentPromise.finally(() => {
            setTimeout(() => {
                if (this.queues.get(contestId) === currentPromise) {
                    this.queues.delete(contestId);
                }
            }, 5000);
        });

        return currentPromise;
    }
}

const contestProcessingQueue = new ContestProcessingQueue();

export const startContestProblemCollection = (
    contestId: string,
    expectedCount: number,
): Promise<any[]> => {
    return new Promise((resolve) => {
        // Store raw Competitive Companion format problems
        const problems: any[] = [];
        const contestKey = `contest-${contestId}`;
        contestProblemsStore.set(contestKey, problems);

        // Set up listener - receives raw Competitive Companion format
        contestCreationListener = (companionProblem: any) => {
            globalThis.logger.log(
                '[Contest Collection] Received problem from Competitive Companion',
            );
            globalThis.logger.log(
                '[Contest Collection] Problem data:',
                JSON.stringify(companionProblem, null, 2),
            );
            globalThis.logger.log(
                `[Contest Collection] Problem URL: ${companionProblem.url}`,
            );
            globalThis.logger.log(
                `[Contest Collection] Problem name: ${companionProblem.name}`,
            );
            globalThis.logger.log(
                `[Contest Collection] Test cases: ${
                    companionProblem.tests?.length || 0
                }`,
            );
            globalThis.logger.log(
                `[Contest Collection] Memory limit: ${companionProblem.memoryLimit}MB`,
            );
            globalThis.logger.log(
                `[Contest Collection] Time limit: ${companionProblem.timeLimit}ms`,
            );

            // Check if this problem belongs to the contest
            // Match both individual problem URLs (/contest/2167/problem/A)
            // and contest problems page (/contest/2167/problems)
            const problemUrl = companionProblem.url;
            const isIndividualProblem = problemUrl.includes(
                `/contest/${contestId}/problem/`,
            );
            const isContestProblemsPage = problemUrl.includes(
                `/contest/${contestId}/problems`,
            );

            if (isIndividualProblem || isContestProblemsPage) {
                globalThis.logger.log(
                    `[Contest Collection] Problem matches contest ${contestId} (individual: ${isIndividualProblem}, contest page: ${isContestProblemsPage})`,
                );

                // Check if we already have this problem
                // When clicking on contest problems page, all problems share the same URL
                // So we prioritize checking by problem name first, then URL for individual problems
                const existing = problems.find((p) => {
                    // First check by name (most reliable for batch submissions)
                    if (
                        companionProblem.name &&
                        p.name === companionProblem.name
                    ) {
                        return true;
                    }
                    // For individual problem pages, also check URL
                    // But don't use URL matching for contest problems page (all problems share same URL)
                    if (isIndividualProblem && p.url === problemUrl) {
                        return true;
                    }
                    return false;
                });
                if (!existing) {
                    problems.push(companionProblem);
                    contestProblemsStore.set(contestKey, problems);

                    globalThis.logger.log(
                        `[Contest Collection] Added problem ${companionProblem.name} (${problems.length}/${expectedCount})`,
                    );
                    globalThis.logger.log(
                        `[Contest Collection] Current problems: ${problems
                            .map((p) => p.name)
                            .join(', ')}`,
                    );

                    vscode.window.showInformationMessage(
                        `Received problem ${companionProblem.name} (${problems.length}/${expectedCount})`,
                    );

                    // If we have all problems, resolve
                    // NOTE: Don't clear contestCreationListener here - let stopContestProblemCollection() handle it
                    // This prevents race conditions where additional problems might create files
                    if (problems.length >= expectedCount) {
                        globalThis.logger.log(
                            `[Contest Collection] All ${expectedCount} problems collected!`,
                        );
                        globalThis.logger.log(
                            `[Contest Collection] Collected problems: ${problems
                                .map((p) => p.name)
                                .join(', ')}`,
                        );
                        contestProblemsStore.delete(contestKey);
                        // Use setTimeout to ensure all async operations complete before resolving
                        setTimeout(() => {
                            resolve(problems);
                        }, 100);
                    }
                } else {
                    globalThis.logger.log(
                        `[Contest Collection] Problem ${companionProblem.name} already exists (URL: ${problemUrl}, existing: ${existing.name}), skipping`,
                    );
                }
            } else {
                globalThis.logger.log(
                    `[Contest Collection] Problem URL ${problemUrl} does not match contest ${contestId}`,
                );
                // Don't process this problem - it doesn't belong to the contest
                // The listener is still active, so we don't want to create files for non-matching problems
            }
        };

        // Timeout after 5 minutes
        // NOTE: Don't clear contestCreationListener here - let stopContestProblemCollection() handle it
        setTimeout(() => {
            contestProblemsStore.delete(contestKey);
            if (problems.length > 0) {
                resolve(problems);
            } else {
                resolve([]);
            }
        }, 300000); // 5 minutes
    });
};

export const stopContestProblemCollection = () => {
    globalThis.logger.log(
        '[Contest Collection] Stopping contest problem collection',
    );
    contestCreationListener = null;
    contestProblemsStore.clear();
    // Reset processing flag after a short delay to allow any pending operations to complete
    setTimeout(() => {
        isProcessingContest = false;
    }, 1000);
};

export const setProcessingContest = (processing: boolean) => {
    isProcessingContest = processing;
    globalThis.logger.log(
        `[Contest Collection] Set processing flag to: ${processing}`,
    );
};

/**
 * Convert Competitive Companion format to our Problem format
 * This is used for the normal flow when handling a single problem
 */
function convertCompanionDataToProblem(companionData: any): Problem {
    // Map test cases from Competitive Companion format
    const tests = (companionData.tests || []).map((test: any) => ({
        input: test.input || '',
        output: test.output || '',
        id: randomId(),
        original: true,
    }));

    const problem: Problem = {
        name: companionData.name || '',
        url: companionData.url || '',
        interactive: companionData.interactive || false,
        memoryLimit: companionData.memoryLimit || DEFAULT_MEMORY_LIMIT,
        timeLimit: companionData.timeLimit || DEFAULT_TIME_LIMIT,
        group: companionData.group || 'local',
        tests: tests,
        srcPath: '', // Will be set by handleNewProblem
    };

    return problem;
}

export const submitKattisProblem = (problem: Problem) => {
    globalThis.reporter.sendTelemetryEvent(telmetry.SUBMIT_TO_KATTIS);
    const srcPath = problem.srcPath;
    const homedir = os.homedir();
    let submitPath = `${homedir}/.kattis/submit.py`;
    if (process.platform == 'win32') {
        if (
            !existsSync(`${homedir}\\.kattis\\.kattisrc`) ||
            !existsSync(`${homedir}\\.kattis\\submit.py`)
        ) {
            vscode.window.showErrorMessage(
                `Please ensure .kattisrc and submit.py are present in ${homedir}\\.kattis\\submit.py`,
            );
            return;
        } else {
            submitPath = `${homedir}\\.kattis\\submit.py`;
        }
    } else {
        if (
            !existsSync(`${homedir}/.kattis/.kattisrc`) ||
            !existsSync(`${homedir}/.kattis/submit.py`)
        ) {
            vscode.window.showErrorMessage(
                `Please ensure .kattisrc and submit.py are present in ${homedir}/.kattis/submit.py`,
            );
            return;
        } else {
            submitPath = `${homedir}/.kattis/submit.py`;
        }
    }
    const pyshell = spawn('python', [submitPath, '-f', srcPath]);

    //tells the python script to open submission window in new tab
    pyshell.stdin.setDefaultEncoding('utf-8');
    pyshell.stdin.write('Y\n');
    pyshell.stdin.end();

    pyshell.stdout.on('data', function (data) {
        globalThis.logger.log(data.toString());
        getJudgeViewProvider().extensionToJudgeViewMessage({
            command: 'new-problem',
            problem,
        });
        ({ command: 'submit-finished' });
    });
    pyshell.stderr.on('data', function (data) {
        globalThis.logger.log(data.tostring());
        vscode.window.showErrorMessage(data);
    });
};

/** Stores a response to be submitted to CF page soon. */
export const storeSubmitProblem = (problem: Problem) => {
    const srcPath = problem.srcPath;
    const problemName = getProblemName(problem.url);
    const sourceCode = readFileSync(srcPath).toString();
    const languageId = getLanguageId(problem.srcPath);
    savedResponse = {
        empty: false,
        url: problem.url,
        problemName,
        sourceCode,
        languageId,
    };
    globalThis.reporter.sendTelemetryEvent(telmetry.SUBMIT_TO_CODEFORCES);
    globalThis.logger.log('Stored savedResponse', savedResponse);
};

/**
 * Handle a single problem from Competitive Companion data.
 */
const handleCompanionProblem = async (companionData: any): Promise<void> => {
    globalThis.logger.log('[Companion Server] Parsed problem successfully');
    globalThis.logger.log(
        '[Companion Server] Problem name:',
        companionData.name,
    );
    globalThis.logger.log('[Companion Server] Problem URL:', companionData.url);
    globalThis.logger.log(
        '[Companion Server] Test cases count:',
        companionData.tests?.length || 0,
    );

    const batchSize = companionData.batch?.size || 1;
    const batchId = companionData.batch?.id || null;
    globalThis.logger.log(
        `[Companion Server] Batch info: size=${batchSize}, id=${batchId}`,
    );

    // Check if we're collecting problems for contest creation
    if (contestCreationListener || isProcessingContest) {
        if (contestCreationListener) {
            globalThis.logger.log(
                '[Companion Server] Contest creation listener active, forwarding raw companion data',
            );
            contestCreationListener(companionData);
        } else {
            globalThis.logger.log(
                `[Companion Server] Contest processing in progress, ignoring problem ${companionData.name} to prevent race condition`,
            );
        }
        return;
    }

    // Normal flow: handle new problem
    globalThis.logger.log(
        '[Companion Server] Normal flow: handling new problem',
    );
    const problem = convertCompanionDataToProblem(companionData);
    await processProblem(problem);
};

/**
 * Handle an array of problems from Competitive Companion.
 */
const handleCompanionProblemArray = async (
    companionDataArray: any[],
): Promise<void> => {
    globalThis.logger.log(
        `[Companion Server] Received array of ${companionDataArray.length} problems`,
    );

    for (let i = 0; i < companionDataArray.length; i++) {
        const problemData = companionDataArray[i];
        globalThis.logger.log(
            `[Companion Server] Processing problem ${i + 1}/${
                companionDataArray.length
            }: ${problemData.name}`,
        );

        // Check if we're collecting problems for contest creation
        if (contestCreationListener || isProcessingContest) {
            if (contestCreationListener) {
                contestCreationListener(problemData);
            }
            continue;
        }

        // Normal flow: convert and handle this problem
        const problem = convertCompanionDataToProblem(problemData);
        await processProblem(problem);
    }
};

/**
 * Process incoming Competitive Companion request.
 */
const processCompanionRequest = async (rawProblem: string): Promise<void> => {
    if (rawProblem === '') {
        globalThis.logger.log('[Companion Server] Received empty request');
        return;
    }

    globalThis.logger.log(
        '[Companion Server] Received data from Competitive Companion',
    );
    globalThis.logger.log(
        '[Companion Server] Raw data length:',
        rawProblem.length,
    );

    const companionData: any = JSON.parse(rawProblem);

    // Check if Competitive Companion sent an array of problems
    if (Array.isArray(companionData)) {
        await handleCompanionProblemArray(companionData);
        return;
    }

    // Single problem
    await handleCompanionProblem(companionData);
};

/**
 * Handle HTTP response for companion requests.
 */
const handleCompanionResponse = (
    res: http.ServerResponse,
    headers: http.IncomingHttpHeaders,
): void => {
    res.write(JSON.stringify(savedResponse));

    if (headers['cph-submit'] === 'true') {
        COMPANION_LOGGING &&
            globalThis.logger.log(
                'Request was from the cph-submit extension; sending savedResponse and clearing it',
                savedResponse,
            );

        if (savedResponse.empty !== true) {
            getJudgeViewProvider().extensionToJudgeViewMessage({
                command: 'submit-finished',
            });
        }
        savedResponse = emptyResponse;
    }

    res.end();
};

export const setupCompanionServer = () => {
    try {
        const server = http.createServer((req, res) => {
            let rawProblem = '';

            req.on('data', (chunk) => {
                COMPANION_LOGGING &&
                    globalThis.logger.log('Companion server got data');
                rawProblem += chunk;
            });

            req.on('close', async () => {
                try {
                    await processCompanionRequest(rawProblem);
                    COMPANION_LOGGING &&
                        globalThis.logger.log(
                            'Companion server closed connection.',
                        );
                } catch (e) {
                    globalThis.logger.error(
                        '[Companion Server] Error parsing problem:',
                        e,
                    );
                    globalThis.logger.error(
                        '[Companion Server] Raw data:',
                        rawProblem,
                    );
                    vscode.window.showErrorMessage(
                        `Error parsing problem from companion "${e}. Raw problem: '${rawProblem}'"`,
                    );
                }
            });

            handleCompanionResponse(res, req.headers);
        });

        server.listen(config.port);
        server.on('error', (err) => {
            vscode.window.showErrorMessage(
                `Are multiple VSCode windows open? CPH will work on the first opened window. CPH server encountered an error: "${err.message}" , companion may not work.`,
            );
        });

        globalThis.logger.log(
            'Companion server listening on port',
            config.port,
        );
        return server;
    } catch (e) {
        globalThis.logger.error('Companion server error :', e);
    }
};

/**
 * Get the filename for a problem based on its properties.
 */
export const getProblemFileName = (problem: Problem, ext: string): string => {
    if (isCodeforcesUrl(new URL(problem.url)) && useShortCodeForcesName()) {
        return `${getProblemName(problem.url)}.${ext}`;
    }

    const words = words_in_text(problem.name);
    if (words === null) {
        return `${problem.name.replace(/\W+/g, '_')}.${ext}`;
    }
    return `${words.join('_')}.${ext}`;
};

/**
 * Extract problem index (A, B, C, etc.) from problem name.
 * Returns null if no index can be extracted.
 */
const extractProblemIndex = (problemName: string): string | null => {
    const match = problemName.match(/^([A-Z])\.?\s/);
    return match ? match[1] : null;
};

/**
 * Get filename for a contest problem.
 * For contest problems page, extracts the problem index (A, B, C, etc.) from the name.
 */
const getContestProblemFileName = (problem: Problem, ext: string): string => {
    const problemIndex = extractProblemIndex(problem.name);
    if (problemIndex) {
        globalThis.logger.log(
            `Extracted problem index ${problemIndex} from name: ${problem.name}`,
        );
        return `${problemIndex}.${ext}`;
    }

    // Fallback: use problem name if index extraction fails
    globalThis.logger.log(
        `Could not extract problem index from name: ${problem.name}, using full name`,
    );
    const words = words_in_text(problem.name);
    if (words === null) {
        return `${problem.name.replace(/\W+/g, '_')}.${ext}`;
    }
    return `${words.join('_')}.${ext}`;
};

/**
 * Get the target folder and filename for a problem.
 * Returns { targetFolder, fileName }.
 */
const getProblemPathInfo = (
    problem: Problem,
    workspaceFolder: string,
    ext: string,
): { targetFolder: string; fileName: string } => {
    const contestMatch = problem.url.match(/\/contest\/(\d+)\/problems/);

    if (!contestMatch) {
        return {
            targetFolder: workspaceFolder,
            fileName: getProblemFileName(problem, ext),
        };
    }

    const contestId = contestMatch[1];
    const contestFolder = path.join(workspaceFolder, `contest-${contestId}`);

    if (!existsSync(contestFolder)) {
        globalThis.logger.log(`Creating contest folder: ${contestFolder}`);
        mkdirSync(contestFolder, { recursive: true });
    }

    globalThis.logger.log(`Using contest folder for problem: ${contestFolder}`);

    return {
        targetFolder: contestFolder,
        fileName: getContestProblemFileName(problem, ext),
    };
};

/**
 * Get the file extension for the problem based on user preferences.
 */
const getProblemExtension = async (): Promise<string | null> => {
    const defaultLanguage = getDefaultLangPref();

    if (defaultLanguage != null) {
        // @ts-ignore
        return config.extensions[defaultLanguage];
    }

    const allChoices = new Set(Object.keys(config.extensions));
    const userChoices = getMenuChoices();
    const choices = userChoices.filter((x) => allChoices.has(x));
    const selected = await vscode.window.showQuickPick(choices);

    if (!selected) {
        vscode.window.showInformationMessage('Aborted creation of new file');
        return null;
    }

    // @ts-ignore
    return config.extensions[selected];
};

/**
 * Normalize problem name for Kattis problems.
 */
const normalizeProblemName = (problem: Problem): void => {
    try {
        const url = new URL(problem.url);
        if (url.hostname === 'open.kattis.com') {
            const splitUrl = problem.url.split('/');
            problem.name = splitUrl[splitUrl.length - 1];
        }
    } catch (err) {
        globalThis.logger.error('Error parsing problem URL:', err);
    }
};

/**
 * Create and save the problem file with template if needed.
 */
const createProblemFile = async (
    srcPath: string,
    problemFileName: string,
    ext: string,
): Promise<void> => {
    if (!existsSync(srcPath)) {
        globalThis.logger.log(
            `[Handle New Problem] Creating new file: ${srcPath}`,
        );
        writeFileSync(srcPath, '');
    } else {
        globalThis.logger.log(
            `[Handle New Problem] File already exists: ${srcPath}`,
        );
    }

    const defaultLanguage = getDefaultLangPref();
    if (!defaultLanguage) {
        return;
    }

    const templateLocation = getDefaultLanguageTemplateFileLocation();
    if (!templateLocation) {
        return;
    }

    const templateExists = existsSync(templateLocation);
    if (!templateExists) {
        vscode.window.showErrorMessage(
            `Template file does not exist: ${templateLocation}`,
        );
        return;
    }

    let templateContents = readFileSync(templateLocation).toString();

    if (ext === 'java') {
        const className = path.basename(problemFileName, '.java');
        templateContents = templateContents.replace('CLASS_NAME', className);
    }

    writeFileSync(srcPath, templateContents);
};

/**
 * Process a problem, queueing it if it's from a contest problems page.
 */
const processProblem = async (problem: Problem): Promise<void> => {
    const contestMatch = problem.url.match(/\/contest\/(\d+)\/problems/);

    if (contestMatch) {
        const contestId = contestMatch[1];
        globalThis.logger.log(
            `[Companion Server] Queueing problem ${problem.name} for contest ${contestId}`,
        );

        await contestProcessingQueue.queue(contestId, async () => {
            globalThis.logger.log(
                `[Companion Server] Processing queued problem ${problem.name} for contest ${contestId}`,
            );
            await handleNewProblem(problem);
            globalThis.logger.log(
                `[Companion Server] Finished processing problem ${problem.name} for contest ${contestId}`,
            );
        });
    } else {
        // Not a contest problems page, process immediately
        await handleNewProblem(problem);
    }
};

/**
 * Handle the `problem` sent by Competitive Companion, such as showing the webview, opening an editor, managing layout etc.
 */
const handleNewProblem = async (problem: Problem): Promise<void> => {
    globalThis.reporter.sendTelemetryEvent(telmetry.GET_PROBLEM_FROM_COMPANION);

    // If webview may be focused, close it, to prevent layout bug.
    if (vscode.window.activeTextEditor === undefined) {
        getJudgeViewProvider().extensionToJudgeViewMessage({
            command: 'new-problem',
            problem: undefined,
        });
    }

    const folder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (folder === undefined) {
        vscode.window.showInformationMessage('Please open a folder first.');
        return;
    }

    const extn = await getProblemExtension();
    if (!extn) {
        return;
    }

    normalizeProblemName(problem);

    const { targetFolder, fileName } = getProblemPathInfo(
        problem,
        folder,
        extn,
    );
    const srcPath = path.join(targetFolder, fileName);

    globalThis.logger.log(
        `[Handle New Problem] Saving problem ${problem.name} to ${srcPath}`,
    );
    globalThis.logger.log(
        `[Handle New Problem] Problem has ${problem.tests.length} test cases`,
    );

    // Add fields absent in competitive companion.
    problem.srcPath = srcPath;
    problem.tests = problem.tests.map((testcase) => ({
        ...testcase,
        id: randomId(),
    }));

    await createProblemFile(srcPath, fileName, extn);

    globalThis.logger.log(
        `[Handle New Problem] Saving problem metadata to .cph folder`,
    );
    saveProblem(srcPath, problem);
    globalThis.logger.log(
        `[Handle New Problem] Successfully saved problem ${problem.name}`,
    );

    const doc = await vscode.workspace.openTextDocument(srcPath);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

    getJudgeViewProvider().extensionToJudgeViewMessage({
        command: 'new-problem',
        problem,
    });
};
