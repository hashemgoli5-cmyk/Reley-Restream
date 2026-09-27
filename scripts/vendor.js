import { mkdir, copyFile, readdir } from 'node:fs/promises';
await mkdir('client/vendor', { recursive: true });
await copyFile('node_modules/hls.js/dist/hls.min.js', 'client/vendor/hls.min.js');
await copyFile('node_modules/hls.js/LICENSE', 'client/vendor/HLS-LICENSE.txt');
for (const name of ['inter', 'vazirmatn']) {
  await copyFile(`node_modules/@fontsource/${name}/LICENSE`, `client/vendor/${name}-LICENSE.txt`);
  const dir = `node_modules/@fontsource/${name}/files`;
  for (const file of await readdir(dir)) {
    if (
      file.endsWith('.woff2') &&
      /-(400|500|600|700)-normal/.test(file) &&
      /(latin|arabic)-/.test(file)
    )
      await copyFile(`${dir}/${file}`, `client/vendor/${file}`);
  }
}
