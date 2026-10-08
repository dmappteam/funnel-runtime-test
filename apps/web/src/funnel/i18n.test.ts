import { describe, expect, it } from 'vitest';
import { getStrings } from './i18n';

describe('unit labels', () => {
  const en = getStrings('en-AU');

  it('uses the singular for a value of 1 and the config unit otherwise', () => {
    expect(en.unit('hours', 1)).toBe('hour');
    expect(en.unit('days', 1)).toBe('day');
    expect(en.unit('tools', 1)).toBe('tool');
    expect(en.unit('people', 1)).toBe('person');
    expect(en.unit('cities', 1)).toBe('city');
    expect(en.unit('class', 1)).toBe('class');
    expect(en.unit('hours', 0)).toBe('hours');
    expect(en.unit('hours', 20)).toBe('hours');
    expect(en.unit('hours', null)).toBe('hours');
  });

  it('keeps the unit as configured in other languages', () => {
    expect(getStrings('ru').unit('hours', 1)).toBe('hours');
  });
});
