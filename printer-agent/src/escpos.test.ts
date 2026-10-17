import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReceiptJob, buildTestJob, validateBitmap } from './escpos';
import { ReceiptJobRunner, sameQueue } from './receiptPrint';

const bmp = (w: number, h: number) => ({ widthDots: w, heightDots: h, bits: Buffer.alloc((w / 8) * h, 0xff) });

test('job starts with init, ends with feed then cut', () => {
  const out = buildReceiptJob(bmp(576, 10), { feedDots: 100 });
  assert.deepEqual([...out.subarray(0, 2)], [0x1b, 0x40]);
  assert.deepEqual([...out.subarray(2, 10)], [0x1d, 0x76, 0x30, 0x00, 72, 0, 10, 0]); // 576/8 = 72 bytes/row, 10 rows
  assert.deepEqual([...out.subarray(-7)], [0x1b, 0x4a, 100, 0x1d, 0x56, 0x42, 0x00]);
});

test('tall bitmaps are split into bands and every row is sent exactly once', () => {
  const out = buildReceiptJob(bmp(576, 600), { feedDots: 0 });
  const bands: number[] = [];
  let i = 2;
  let rows = 0;
  while (i < out.length - 4) {
    assert.deepEqual([...out.subarray(i, i + 4)], [0x1d, 0x76, 0x30, 0x00]);
    const r = out[i + 6] | (out[i + 7] << 8);
    bands.push(r); rows += r; i += 8 + 72 * r;
  }
  assert.deepEqual(bands, [256, 256, 88]);
  assert.equal(rows, 600);
  assert.equal(i, out.length - 4); // only the cut remains
});

test('cut can be disabled and large feeds are chunked', () => {
  const out = buildReceiptJob(bmp(8, 1), { feedDots: 300, cut: false });
  assert.deepEqual([...out.subarray(-6)], [0x1b, 0x4a, 255, 0x1b, 0x4a, 45]);
});

test('validation rejects bad geometry and mismatched data', () => {
  assert.match(validateBitmap({ ...bmp(576, 5), widthDots: 575 })!, /multiple of 8/);
  assert.match(validateBitmap({ ...bmp(576, 5), bits: Buffer.alloc(3) })!, /length/);
  assert.match(validateBitmap(bmp(1000, 5))!, /at most/);
  assert.match(validateBitmap({ widthDots: 576, heightDots: 99999, bits: Buffer.alloc(0) })!, /at most/);
  assert.equal(validateBitmap(bmp(576, 5)), null);
  assert.throws(() => buildReceiptJob(bmp(575, 1)));
});

test('test job is ascii only and cuts', () => {
  const out = buildTestJob(['TRIVO ₹ test']);
  assert.ok(out.includes(Buffer.from('TRIVO ? test')));
  assert.deepEqual([...out.subarray(-4)], [0x1d, 0x56, 0x42, 0x00]);
});

test('runner: same jobId is sent once, even concurrently and after completion', async () => {
  const r = new ReceiptJobRunner();
  let sends = 0;
  const send = async () => { sends++; await new Promise((x) => setTimeout(x, 20)); };
  const [a, b] = await Promise.all([r.run('j1', send), r.run('j1', send)]);
  const c = await r.run('j1', send);
  assert.equal(sends, 1);
  assert.deepEqual([a.duplicate, b.duplicate, c.duplicate], [false, true, true]);
});

test('runner: jobs are serialized and a failed job can be retried with the same id', async () => {
  const r = new ReceiptJobRunner();
  const log: string[] = [];
  const mk = (n: string, ms: number) => async () => { log.push(n + ':start'); await new Promise((x) => setTimeout(x, ms)); log.push(n + ':end'); };
  await Promise.all([r.run('a', mk('a', 30)), r.run('b', mk('b', 5))]);
  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end']);

  let attempts = 0;
  await assert.rejects(r.run('x', async () => { attempts++; throw new Error('offline'); }), /offline/);
  const ok = await r.run('x', async () => { attempts++; });
  assert.equal(attempts, 2);
  assert.equal(ok.duplicate, false);
  await r.run('y', async () => {}); // the queue is not poisoned by the failure
});

test('sameQueue: label and receipt roles may not share a Windows printer', () => {
  assert.equal(sameQueue('EPSON TM-m30III Receipt', ' epson tm-m30iii receipt '), true);
  assert.equal(sameQueue('TSC TTP-244 Pro', 'EPSON TM-m30III Receipt'), false);
  assert.equal(sameQueue(null, 'EPSON'), false);
});
