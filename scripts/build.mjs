import fs from 'node:fs';

const mainModules = ['namespace', 'geometry', 'state', 'sources', 'persistence', 'acoustics', 'wave-solver', 'ray-tracer', 'analysis', 'worker', 'controller', 'renderer', 'app'];
const workerModules = ['namespace', 'geometry', 'sources', 'acoustics', 'wave-solver', 'ray-tracer', 'analysis', 'worker'];
const read = path => fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
const mainSource = mainModules.map(name => read(`src/${name}.js`)).join('\n');
const workerSource = workerModules.map(name => read(`src/${name}.js`)).join('\n') + '\nRoomWave.installWorker(globalThis);';
const template = read('src/index.html');
const html = template
  .replace('/*__INLINE_STYLES__*/', read('src/styles.css'))
  .replace('/*__WORKER_BOOTSTRAP__*/', `globalThis.__ROOM_WAVE_WORKER_SOURCE__ = ${JSON.stringify(workerSource)};`)
  .replace('/*__INLINE_SCRIPTS__*/', mainSource);

fs.writeFileSync('acoustic-room-simulator.html', html);
