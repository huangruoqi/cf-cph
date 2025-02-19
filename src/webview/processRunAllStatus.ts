import * as vscode from 'vscode';
import { Problem, RunResult } from '../types';
import { compileFile, getBinSaveLocation } from '../compiler';
import { deleteBinary, runTestCase } from '../executions';
import { getLanguage } from '../utils';
import { saveProblem } from '../parser';
import { getIgnoreSTDERRORPref } from '../preferences';
import { isResultCorrect } from '../judge';
import { getJudgeViewProvider } from '../extension';

/**
 * Run every testcase in a problem one by one. Waits for the first to complete
 * before running next. `runSingleAndSave` takes care of saving.
 **/

let isRunning = false;
function postStatus(pass: boolean) {
    isRunning = false;
    getJudgeViewProvider().extensionToJudgeViewMessage({
        command: pass ? 'status-yay' : 'status-nay',
    });
}
export default async (problem: Problem) => {
    isRunning = true;
    globalThis.logger.log('Run all status started', problem);
    const didCompile = await compileFile(problem.srcPath);
    if (!didCompile) {
        return postStatus(false);
    }

    for (const testCase of problem.tests) {
        if (!await runSingle(problem, testCase.id)) {
            return postStatus(false);
        }
    }
    globalThis.logger.log('Run all status finished');
    deleteBinary(
        getLanguage(problem.srcPath),
        getBinSaveLocation(problem.srcPath),
    );
    return postStatus(true);
};

export const runSingle = async (
    problem: Problem,
    id: number,
) => {
    globalThis.logger.log('Run and save started', problem, id);
    const srcPath = problem.srcPath;
    const language = getLanguage(srcPath);
    const binPath = getBinSaveLocation(srcPath);
    const idx = problem.tests.findIndex((value) => value.id === id);
    const testCase = problem.tests[idx];

    if (!testCase) {
        globalThis.logger.error('Invalid id', id, problem);
        return false;
    }

    const run = await runTestCase(language, binPath, testCase.input);

    const stderrorFailure = getIgnoreSTDERRORPref() ? false : run.stderr !== '';

    const didError =
        (run.code !== null && run.code !== 0) ||
        run.signal !== null ||
        stderrorFailure;
    return didError ? false : isResultCorrect(testCase, run.stdout);
};

