// Inlines CSS + JS modules into one self-contained preview.html with sample data (no Firebase).
import { readFileSync, writeFileSync } from 'fs';
const order = ['js/format.js', 'js/data.js', 'js/calc.js', 'js/cas.js', 'js/app.js', 'js/preview-main.js'];
const strip = (src) => src
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
  .replace(/^export\s+(const|function|let|class|async function)/gm, '$1');
const js = order.map((f) => `// ---- ${f}\n` + strip(readFileSync(f, 'utf8'))).join('\n');
const css = readFileSync('styles.css', 'utf8');
let html = readFileSync('index.html', 'utf8')
  .replace('<link rel="stylesheet" href="styles.css" />', () => `<style>\n${css}\n</style>`)
  .replace(/<div class="gate" id="gate">.*?<\/div><\/div>\n/, '<div class="gate" id="gate" hidden></div>\n')
  .replace('<div class="app" hidden>', '<div class="app">')
  .replace('<script type="module" src="js/main.js"></script>', () => `<script type="module">\n${js}\n</script>`);
writeFileSync(process.argv[2] || 'preview.html', html);
console.log('wrote', process.argv[2] || 'preview.html', html.length, 'bytes');
