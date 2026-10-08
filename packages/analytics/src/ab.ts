import type { AbComparison, GroupReport, ProportionTest, Rate } from '@funnel/contracts';
import { requiredSampleSize, twoProportionTest } from './stats';
import { groupBy } from './util';

const ALPHA = 0.05;
/** Effect the sample-size estimate targets when no difference can be observed. */
const FALLBACK_EFFECT = 0.05;

function proportionTest(metric: ProportionTest['metric'], control: Rate, treatment: Rate): ProportionTest {
  const t = twoProportionTest(control.numerator, control.denominator, treatment.numerator, treatment.denominator);
  return {
    metric,
    control,
    treatment,
    absDiff: t?.absDiff ?? null,
    diffCiLow: t?.diffCiLow ?? null,
    diffCiHigh: t?.diffCiHigh ?? null,
    relativeLift: t?.relativeLift ?? null,
    pValue: t?.pValue ?? null,
    significant: t !== null && t.pValue < ALPHA,
  };
}

function requiredSessions(control: Rate, treatment: Rate): number | null {
  const p1 = control.value;
  if (p1 === null) return null;
  let p2 = treatment.value;
  if (p2 === null || p2 === p1) {
    // Near 100% the +5 p.p. target would leave [0, 1], so it points down instead.
    p2 = p1 + FALLBACK_EFFECT <= 1 ? p1 + FALLBACK_EFFECT : p1 - FALLBACK_EFFECT;
  }
  return requiredSampleSize(p1, p2);
}

/** Control is the first variant in config order, treatment the second. Expects `groups` sorted by version and variant order. */
export function compareVariants(groups: readonly GroupReport[]): AbComparison[] {
  const out: AbComparison[] = [];
  for (const [version, list] of groupBy(groups, (g) => g.version)) {
    const [control, treatment] = list;
    if (!control || !treatment) continue;
    out.push({
      version,
      experimentId: control.experimentId,
      control: control.variant,
      treatment: treatment.variant,
      primary: proportionTest('ctaConversion', control.kpi.ctaConversion, treatment.kpi.ctaConversion),
      secondary: [
        proportionTest('resultRate', control.kpi.resultRate, treatment.kpi.resultRate),
        proportionTest('ctr', control.kpi.ctr, treatment.kpi.ctr),
      ],
      requiredSessionsPerVariant: requiredSessions(control.kpi.ctaConversion, treatment.kpi.ctaConversion),
    });
  }
  return out;
}
