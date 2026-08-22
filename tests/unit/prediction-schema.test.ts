import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import documentSchema from '../../schemas/document.schema.json';
import { document } from '../fixtures';

describe('dormant model provenance boundary', () => {
  it('round-trips optional model provenance without shipping a prediction workflow', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(documentSchema);
    const payload = structuredClone(document);
    payload.boxes[0].provenance = {
      source: 'model',
      model: { name: 'future-detector', version: '0', runId: 'fixture' },
      sourceDetectionId: 'detection:one',
      confidence: 0.8,
      mappingRuleId: 'project:future',
      humanModified: true,
      candidates: [
        {
          rawClass: 'green-tree-frog',
          score: 0.8,
          mappedSpeciesId: 'local:per',
        },
      ],
    };

    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});
