const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'public', 'obfuscated');
fs.mkdirSync(outDir, { recursive: true });

['db.js', 'app.js'].forEach(file => {
  const code = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');

  const result = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    deadCodeInjection: false,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    selfDefending: false,
    debugProtection: false,
    renameGlobals: false,
    sourceMap: false
  });

  fs.writeFileSync(path.join(outDir, file), result.getObfuscatedCode());
  console.log('Obfuscated:', file);
});