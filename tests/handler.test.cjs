const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const sharp = require('sharp');

const code = transformSync(readFileSync(join(__dirname, '../src/index.ts'), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'node22',
}).code;

function setup(env = {}, objects = {}) {
  const writes = [];
  const reads = [];
  const logs = [];
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class PutObjectCommand { constructor(input) { this.input = input; } }
  class S3Client {
    async send(command) {
      if (command instanceof GetObjectCommand) {
        reads.push(command.input);
        const data = objects[command.input.Key];
        if (!data) throw new Error('Objeto no disponible');
        return { Body: { transformToByteArray: async () => data } };
      }
      writes.push(command.input);
      return {};
    }
  }
  const sandbox = {
    module: { exports: {} }, process: { env },
    console: { log: (...args) => logs.push(args), error: () => {} },
    require: (name) => name === 'sharp' ? sharp : { S3Client, GetObjectCommand, PutObjectCommand },
  };
  vm.runInNewContext(code, sandbox);
  return { handler: sandbox.module.exports.handler, writes, reads, logs };
}

function event(...keys) {
  return { Records: keys.map((key) => ({
    eventName: 'ObjectCreated:Put',
    s3: { bucket: { name: 'test-bucket' }, object: { key } },
  })) };
}

test('JPEG y PNG: dimensiones, keys codificados, MIME, repetición y originales intactos', async () => {
  const original = await sharp({ create: {
    width: 40, height: 20, channels: 3, background: 'red',
  } }).png().toBuffer();
  const jpg = await sharp(original).jpeg().toBuffer();
  const app = setup({}, { 'originals/álbum/foto +.jpg': jpg, 'originals/foto.png': original });
  const input = event('originals%2F%C3%A1lbum%2Ffoto+%2B.jpg', 'originals/foto.png');
  await app.handler(input);
  await app.handler(input);
  assert.equal(app.writes.length, 4);
  assert.equal(app.writes[0].Key, 'resized/álbum/foto +-resized.jpg');
  assert.equal(app.writes[1].Key, 'resized/foto-resized.png');
  for (let i = 0; i < app.writes.length; i++) {
    const output = app.writes[i];
    const metadata = await sharp(output.Body).metadata();
    assert.equal(metadata.width, 1280);
    assert.equal(metadata.height, 720);
    assert.equal(metadata.format, i % 2 ? 'png' : 'jpeg');
    assert.equal(output.ContentType, i % 2 ? 'image/png' : 'image/jpeg');
    assert.equal(output.Bucket, 'test-bucket');
    assert.ok(output.Key.startsWith('resized/'));
  }
  assert.equal(app.writes[0].Key, app.writes[2].Key);
  assert.deepEqual(app.writes[0].Body, app.writes[2].Body);
  assert.equal(app.logs[0][1].result, 'success');
});

test('ignora otros prefijos y formatos sin acceder a S3', async () => {
  const app = setup();
  await app.handler(event('resized/foto.png', 'foto.jpg', 'originals/texto.txt'));
  assert.equal(app.reads.length, 0);
  assert.equal(app.writes.length, 0);
});

test('continúa después de errores y aplica WIDTH y HEIGHT', async () => {
  const image = await sharp({ create: {
    width: 10, height: 30, channels: 4, background: 'blue',
  } }).png().toBuffer();
  const app = setup({ WIDTH: '80', HEIGHT: '50' }, { 'originals/ok.png': image });
  await assert.rejects(app.handler(event('originals/%ZZ.jpg', 'originals/missing.jpg', 'originals/ok.png')),
    /2 objeto/);
  assert.equal(app.writes.length, 1);
  const metadata = await sharp(app.writes[0].Body).metadata();
  assert.equal(metadata.width, 80);
  assert.equal(metadata.height, 50);
});

test('rechaza dimensiones inválidas', async () => {
  for (const WIDTH of ['0', '-1', 'abc', '12px', '1.5']) {
    await assert.rejects(setup({ WIDTH }).handler(event()), /entero positivo/);
  }
});
