import * as fs from 'fs';
import * as path from 'path';

export function validatePluginWithAjv(manifest: any): { ok: boolean; message?: string } {
  try {
    // Try to load ajv lazily. If not installed, signal that caller should fallback.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Ajv = require('ajv');
    const ajv = new Ajv();
    const schemaPath = path.join(process.cwd(), 'plugins', 'plugin.schema.json');
    if (!fs.existsSync(schemaPath)) return { ok: false, message: 'Plugin schema not found' };
    const schemaRaw = fs.readFileSync(schemaPath, 'utf8');
    const schema = JSON.parse(schemaRaw);
    const validate = ajv.compile(schema);
    const valid = validate(manifest);
    if (valid) return { ok: true };
    const msg = validate.errors ? ajv.errorsText(validate.errors) : 'validation failed';
    return { ok: false, message: msg };
  } catch (e) {
    // ajv not available or other error — signal fallback
    return { ok: false, message: 'ajv not available' };
  }
}
