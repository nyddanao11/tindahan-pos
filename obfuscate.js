const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

// 1. Define the list of files to obfuscate
const filesToObfuscate = ['db.js', 'app.js', 'license.js'];

// 2. Create the output directory
const outDir = path.join(__dirname, 'public', 'obfuscated');
fs.mkdirSync(outDir, { recursive: true });

// 3. Loop through the ACTUAL array variable, not a hardcoded list
filesToObfuscate.forEach(file => {
  const filePath = path.join(__dirname, 'public', file);
  
  // Check if file exists to prevent crashes if a file is missing
  if (!fs.existsSync(filePath)) {
    console.warn(`Warning: ${file} not found in public/ folder. Skipping.`);
    return;
  }

  const code = fs.readFileSync(filePath, 'utf8');

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
  console.log('✅ Obfuscated:', file);
});

console.log('🎉 All files obfuscated successfully!');