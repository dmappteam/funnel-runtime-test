import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, UnconfirmedError, UnreachableError } from './api';
import { USAGE, parseCliArgs } from './args';
import { ScenarioError, runScenario } from './scenarios';
import { FetchTransport } from './transport';

const CONFIGS_DIR = fileURLToPath(new URL('../../../configs', import.meta.url));

async function main(): Promise<number> {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2), process.env, CONFIGS_DIR);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 1;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  try {
    const { report } = await runScenario({ ...options, transport: new FetchTransport(options.url) });
    if (options.report) {
      const file = resolve(options.report);
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`Report written to ${file}`);
    }
    return report.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof UnreachableError || err instanceof UnconfirmedError || err instanceof ScenarioError || err instanceof HttpError) {
      console.error(`\nERROR: ${err.message}`);
    } else {
      console.error('\nERROR:', err);
    }
    return 1;
  }
}

process.exitCode = await main();
