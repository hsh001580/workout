import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

test('서비스 워커가 모든 앱 JS 파일을 오프라인용으로 캐시', () => {
  const sw = readFileSync('sw.js', 'utf8');
  for (const f of readdirSync('js').filter((f) => f.endsWith('.js'))) assert.ok(sw.includes(`'js/${f}'`), `sw.js CORE에 js/${f} 누락`);
});

test('매니페스트 아이콘 파일 존재', () => {
  const m = JSON.parse(readFileSync('manifest.webmanifest', 'utf8'));
  assert.equal(m.display, 'standalone');
  for (const i of m.icons) assert.ok(existsSync(i.src), i.src);
});
