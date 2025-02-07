import { Problem } from '../types';
import { runSingleAndSave } from './processRunSingle';
import { compileFile, getBinSaveLocation } from '../compiler';
import { deleteBinary } from '../executions';
import { getLanguage } from '../utils';
import { getJudgeViewProvider } from '../extension';

/**
 * Run every testcase in a problem one by one. Waits for the first to complete
 * before running next. `runSingleAndSave` takes care of saving.
 **/
let isRunning = false;
export default async (problem: Problem) => {
    if (isRunning) {
        globalThis.logger.log('Run all has started', problem);
        return;
    }
    isRunning = true;
    globalThis.logger.log('Run all started', problem);
    const didCompile = await compileFile(problem.srcPath);
    if (!didCompile) {
        return;
    }
    for (const testCase of problem.tests) {
        getJudgeViewProvider().extensionToJudgeViewMessage({
            command: 'running',
            id: testCase.id,
            problem: problem,
        });
        await runSingleAndSave(problem, testCase.id, true, true);
    }
    globalThis.logger.log('Run all finished');
    deleteBinary(
        getLanguage(problem.srcPath),
        getBinSaveLocation(problem.srcPath),
    );
    isRunning = false;
};
