import { analyzeCapture, loadCaptureLimits } from './prediction-capture.mjs';

// Explicit bounds are mandatory: node eng/prediction-capture-cli.mjs manifest.json limits.json
try {
  if (process.argv.length !== 4) throw new Error('usage: node eng/prediction-capture-cli.mjs <manifest.json> <limits.json>');
  const report = await analyzeCapture(process.argv[2], await loadCaptureLimits(process.argv[3]));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: 'Rejected', reason: error.message })}\n`);
  process.exitCode = 1;
}
