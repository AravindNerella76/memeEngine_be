/**
 * The reaction library's input rules (no database): folder names, tags, list queries, edits and bulk actions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { Errors, isReactionId, normalizeCategory, normalizeTags, validateReactionBulk, validateReactionPatch, validateReactionQuery } from '../security/request-validation';

const ID = '3f2b8c1e-5a4d-4e6f-9a0b-1c2d3e4f5a6b';

describe('reaction folder names', () => {
  it('are lower-cased, trimmed and single-spaced', () => {
    assert.equal(normalizeCategory('  Sad   Funny '), 'sad funny');
    assert.equal(normalizeCategory('Bramhi laughing'), 'bramhi laughing');
  });
  it('allow any language, digits, - and _', () => {
    assert.equal(normalizeCategory('బ్రహ్మి నవ్వు'), 'బ్రహ్మి నవ్వు');
    assert.equal(normalizeCategory('top_10-hits'), 'top_10-hits');
  });
  it('refuse empty, too long, or symbols that could be markup or paths', () => {
    for (const bad of ['', '   ', 'a'.repeat(41), '../etc', 'a/b', '<b>x</b>', '-start', 'x$y', null, undefined, 5, {}, ['a']]) {
      assert.equal(normalizeCategory(bad as any), null, String(bad));
    }
  });
});

describe('reaction tags', () => {
  it('split on commas, trim, lower-case and drop repeats and empties', () => {
    const e = new Errors();
    assert.deepEqual(normalizeTags(' Brahmanandam, theatre ,, brahmanandam', e), ['brahmanandam', 'theatre']);
    assert.equal(e.list.length, 0);
  });
  it('accept an array, and leave "not sent" as undefined', () => {
    const e = new Errors();
    assert.deepEqual(normalizeTags(['a', 'B'], e), ['a', 'b']);
    assert.equal(normalizeTags(undefined, e), undefined);
    assert.equal(e.list.length, 0);
  });
  it('refuse odd characters, long tags and more than 12', () => {
    for (const bad of ['<script>', 'x'.repeat(31), Array.from({ length: 13 }, (_, i) => `t${i}`).join(','), [1], { a: 1 }]) {
      const e = new Errors();
      normalizeTags(bad as any, e);
      assert.ok(e.list.length > 0, String(bad));
    }
  });
});

describe('reaction list query', () => {
  it('has sensible defaults', () => {
    const q = validateReactionQuery({});
    assert.deepEqual(q, { category: undefined, search: undefined, sort: 'newest', limit: 48, skip: 0 });
  });
  it('normalizes the folder and keeps "all" as no filter', () => {
    assert.equal(validateReactionQuery({ category: 'Sad Funny' }).category, 'sad funny');
    assert.equal(validateReactionQuery({ category: 'all' }).category, undefined);
  });
  it('rejects operator objects, bad sorts and out-of-range paging', () => {
    for (const bad of [{ category: { $ne: 'x' } }, { search: ['a'] }, { sort: 'random' }, { limit: '500' }, { limit: '0' }, { skip: '-1' }, { category: '../x' }]) {
      assert.throws(() => validateReactionQuery(bad), BadRequestException, JSON.stringify(bad));
    }
  });
});

describe('reaction edits', () => {
  it('accept a folder, a name and tags, and only those', () => {
    assert.deepEqual(validateReactionPatch({ category: 'Shocking', name: '  Brahmi   shocked ', tags: 'brahmanandam' }), { category: 'shocking', name: 'Brahmi shocked', tags: ['brahmanandam'] });
    assert.deepEqual(validateReactionPatch({ name: '' }), { name: '' });
    assert.deepEqual(validateReactionPatch({ sha256: 'x', data: 'y', category: 'sad' } as any), { category: 'sad' });
  });
  it('refuse a bad folder name', () => {
    assert.throws(() => validateReactionPatch({ category: '' }), BadRequestException);
    assert.throws(() => validateReactionPatch({ category: '../x' }), BadRequestException);
  });
});

describe('reaction bulk actions', () => {
  it('accept move with a folder and delete without one', () => {
    assert.deepEqual(validateReactionBulk({ action: 'move', ids: [ID], category: 'Sad' }), { action: 'move', ids: [ID], category: 'sad' });
    assert.deepEqual(validateReactionBulk({ action: 'delete', ids: [ID] }), { action: 'delete', ids: [ID], category: undefined });
  });
  it('refuse unknown actions, bad ids, no ids, too many ids, and a move without a folder', () => {
    for (const bad of [
      { action: 'purge', ids: [ID] },
      { action: 'delete', ids: ['nope'] },
      { action: 'delete', ids: [] },
      { action: 'delete' },
      { action: 'delete', ids: Array.from({ length: 201 }, () => ID) },
      { action: 'move', ids: [ID] },
      { action: 'delete', ids: [{ $ne: 1 }] }
    ]) {
      assert.throws(() => validateReactionBulk(bad), BadRequestException, JSON.stringify(bad).slice(0, 60));
    }
  });
});

describe('reaction ids', () => {
  it('are UUIDs only', () => {
    assert.ok(isReactionId(ID));
    for (const bad of ['', 'abc', '../x', `${ID}x`, 5, null, undefined]) assert.equal(isReactionId(bad as any), false);
  });
});
