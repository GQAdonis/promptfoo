import { getDefaultPort } from '../../constants';
import logger from '../../logger';
import { startServer } from '../../server/server';
import telemetry from '../../telemetry';
import { setupEnv } from '../../util';
import { setConfigDirectoryPath } from '../../util/config/manage';
import { BrowserBehavior, checkServerRunning, openBrowser } from '../../util/server';
import type { Command } from 'commander';

export function redteamReportCommand(program: Command) {
  program
    .command('report [directory]')
    .description('Start browser UI and open to report')
    .option('-p, --port <number>', 'Port number', getDefaultPort().toString())
    .option('--filter-description <pattern>', 'Filter evals by description using a regex pattern')
    .option('--env-file, --env-path <path>', 'Path to .env file')
    .action(
      async (
        directory: string | undefined,
        cmdObj: {
          port: number;
          apiBaseUrl?: string;
          envPath?: string;
          filterDescription?: string;
        } & Command,
      ) => {
        setupEnv(cmdObj.envPath);
        telemetry.record('command_used', {
          name: 'redteam report',
        });

        if (directory) {
          setConfigDirectoryPath(directory);
        }
        if (cmdObj.filterDescription) {
          logger.warn(
            'The --filter-description option is deprecated and not longer supported. The argument will be ignored.',
          );
        }

        const isRunning = await checkServerRunning();
        if (isRunning) {
          await openBrowser(BrowserBehavior.OPEN_TO_REPORT);
        } else {
          await startServer(cmdObj.port, BrowserBehavior.OPEN_TO_REPORT);
        }
      },
    );
}
