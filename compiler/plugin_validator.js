const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const schemaPath = path.join(__dirname, '..', 'plugins', 'plugin.schema.json');
let schema = null;
try {
  schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
} catch (e) {
  schema = null;
}

const ajv = new Ajv({ allErrors: true });
let validate = null;
if (schema) validate = ajv.compile(schema);

function validatePluginObject(obj) {
  if (!validate) return { valid: false, errors: ['Plugin schema not found'] };
  const ok = validate(obj);
  if (!ok) return { valid: false, errors: validate.errors.map(e => `${e.instancePath} ${e.message}`) };
  return { valid: true, errors: [] };
}

function validatePluginFile(filePath) {
  try {
    const p = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return validatePluginObject(p);
  } catch (e) {
    return { valid: false, errors: [e.message] };
  }
}

module.exports = { validatePluginObject, validatePluginFile };
