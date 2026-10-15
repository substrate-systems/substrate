import * as esbuild from 'esbuild';
import fs from 'fs';
const NAMES = ['Mark', 'Wordmark', 'AliveGraph', 'Progress', 'LiveLine', 'Steps', 'Notice', 'Button', 'TextField', 'Switch', 'Swap', 'Crossfade', 'Collapse', 'FadeIn', 'Skeleton'];
const globals = { name: 'globals', setup(b) {
  b.onResolve({ filter: /^react(-dom)?$/ }, (a) => ({ path: a.path, namespace: 'g' }));
  b.onLoad({ filter: /.*/, namespace: 'g' }, (a) => ({ contents: `module.exports = window.${a.path === 'react' ? 'React' : 'ReactDOM'};`, loader: 'js' }));
} };
const r = await esbuild.build({ entryPoints: ['src/index.tsx'], bundle: true, format: 'iife', globalName: 'Exomem', minify: true, write: false,
  jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [globals], target: 'es2020' });
let js = r.outputFiles[0].text;
js = `/* @ds-bundle: ${JSON.stringify({ format: 4, namespace: 'Exomem', components: NAMES.map((n) => ({ name: n })) })} */\n` + js + `\nwindow.Exomem = Exomem;\n`;
if (/<\/script|<!--/i.test(js)) throw new Error('bundle contains </script or <!--');
const out = process.argv[2];
fs.writeFileSync(out + '/components/bundle.js', js);
const css = `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500&display=swap');\n/* the writing E */` + fs.readFileSync('src/writing-e.css', 'utf8') + '\n' + fs.readFileSync('src/components.css', 'utf8');
fs.writeFileSync(out + '/components/bundle.css', css);
console.log('bundle', js.length, 'css', css.length);
