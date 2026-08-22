import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import catalogSchema from '../../schemas/catalog.schema.json';
import documentSchema from '../../schemas/document.schema.json';
import localFileSchema from '../../schemas/local-file.schema.json';
import messageSchema from '../../schemas/reactcode-message.schema.json';
import speciesSchema from '../../schemas/species.schema.json';
import taskDataSchema from '../../schemas/task-data.schema.json';

const schemas = [
  catalogSchema,
  documentSchema,
  localFileSchema,
  messageSchema,
  speciesSchema,
  taskDataSchema,
];

describe('published JSON Schema suite', () => {
  it('compiles all six shipping schemas together in strict draft-2020 mode', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    for (const schema of schemas) ajv.addSchema(schema);
    for (const schema of schemas) expect(ajv.getSchema(schema.$id)).toBeTypeOf('function');
  });

  it('accepts complete Label Studio task data while validating FrogLabel fields', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(taskDataSchema);
    expect(
      validate({
        froglabel: '/data/upload/1/example.wav',
        source: '{"id":1,"project":1}',
        unrelatedProjectField: { retained: true },
      }),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(validate({ froglabel: { url: '/data/upload/1/example.wav' } })).toBe(false);
  });
});
