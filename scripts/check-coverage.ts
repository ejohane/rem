import { existsSync, readFileSync } from "node:fs";

type CoverageTotals = {
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
};

function parseMinPercent(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseLcovTotals(contents: string): CoverageTotals {
  const totals: CoverageTotals = {
    linesFound: 0,
    linesHit: 0,
    functionsFound: 0,
    functionsHit: 0,
  };

  for (const line of contents.split("\n")) {
    if (line.startsWith("LF:")) {
      totals.linesFound += Number.parseInt(line.slice(3), 10) || 0;
      continue;
    }

    if (line.startsWith("LH:")) {
      totals.linesHit += Number.parseInt(line.slice(3), 10) || 0;
      continue;
    }

    if (line.startsWith("FNF:")) {
      totals.functionsFound += Number.parseInt(line.slice(4), 10) || 0;
      continue;
    }

    if (line.startsWith("FNH:")) {
      totals.functionsHit += Number.parseInt(line.slice(4), 10) || 0;
    }
  }

  return totals;
}

function toPercent(hit: number, found: number): number {
  if (found === 0) {
    return 100;
  }

  return (hit / found) * 100;
}

const lcovPath = process.argv[2] ?? "coverage/lcov.info";
const minLineCoverage = parseMinPercent(process.env.MIN_LINE_COVERAGE, 75);
const minFunctionCoverage = parseMinPercent(process.env.MIN_FUNCTION_COVERAGE, 75);

if (!existsSync(lcovPath)) {
  process.stderr.write(`Coverage file not found: ${lcovPath}\n`);
  process.exit(1);
}

const totals = parseLcovTotals(readFileSync(lcovPath, "utf8"));
const lineCoverage = toPercent(totals.linesHit, totals.linesFound);
const functionCoverage = toPercent(totals.functionsHit, totals.functionsFound);

const failures: string[] = [];
if (lineCoverage < minLineCoverage) {
  failures.push(
    `line coverage ${lineCoverage.toFixed(2)}% is below minimum ${minLineCoverage.toFixed(2)}%`,
  );
}

if (functionCoverage < minFunctionCoverage) {
  failures.push(
    `function coverage ${functionCoverage.toFixed(2)}% is below minimum ${minFunctionCoverage.toFixed(2)}%`,
  );
}

if (failures.length > 0) {
  process.stderr.write(`Coverage check failed:\n- ${failures.join("\n- ")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Coverage check passed: lines=${lineCoverage.toFixed(2)}% funcs=${functionCoverage.toFixed(2)}% (minimum lines=${minLineCoverage.toFixed(2)}%, funcs=${minFunctionCoverage.toFixed(2)}%)\n`,
);
