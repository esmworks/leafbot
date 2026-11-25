import { describe, expect, it } from 'vitest';
import { namesWanted } from './RoutineInputs';
import type { StepForm } from './RoutineSteps';

describe('rutin girdileri', () => {
  it('metinlerde geçip ne bir girdinin ne de önceki bir değer adımının verdiği adları önerir', () => {
    const steps: StepForm[] = [
      { id: 'x', kind: 'extract', fields: 'price=items.0.price' },
      { id: 'a', kind: 'agent', prompt: 'Compare {{price}} for {{audience}}', model: '' },
      { id: 'n', kind: 'notify', text: 'Done: {{topic}}', withBefore: false },
    ] as StepForm[];
    expect(namesWanted('Research {{topic}} in {{lang}}', steps, [{ name: 'lang', value: 'tr' }])).toEqual([
      'topic',
      'audience',
    ]);
  });
});
