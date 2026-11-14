import test from 'node:test';
import assert from 'node:assert/strict';
import { librarySource, sortLibraryPhotos, selectedLibraryPhotos } from '../public/library.js';

test('library sorts original pixel area in either direction and leaves unknown sizes last', () => {
  const photos = [{ id: 'unknown' }, { id: 'wide', width: 1000, height: 20, bytes: 9000 }, { id: 'square', width: 200, height: 200, bytes: 10 }];
  assert.deepEqual(sortLibraryPhotos(photos, 'area', 'desc').map(p => p.id), ['square', 'wide', 'unknown']);
  assert.deepEqual(sortLibraryPhotos(photos, 'area', 'asc').map(p => p.id), ['wide', 'square', 'unknown']);
  assert.equal(photos[0].id, 'unknown');
});

test('VK dates sort in either direction with unknown dates last and stable ties', () => {
  const photos = [{ id: 'b', date: 100 }, { id: 'unknown' }, { id: 'a', date: 100 }, { id: 'new', date: 200 }];
  assert.deepEqual(sortLibraryPhotos(photos, 'date', 'desc').map(p => p.id), ['new', 'a', 'b', 'unknown']);
  assert.deepEqual(sortLibraryPhotos(photos, 'date', 'asc').map(p => p.id), ['a', 'b', 'new', 'unknown']);
});

test('library sources include excluded photo records without metadata', () => {
  assert.equal(librarySource({ id: 'local_abc' }), 'local');
  assert.equal(librarySource({ id: 'vk_-1_123' }), 'vk');
  assert.equal(librarySource({ id: 'custom', source: 'local' }), 'local');
});

test('computer photos sort by addition date rather than VK dates', () => {
  const photos = [
    { id: 'local_old', source: 'local', addedAt: 1000, date: 99999 },
    { id: 'local_new', source: 'local', addedAt: 2000, date: 1 },
    { id: 'local_missing', source: 'local' },
  ];
  assert.deepEqual(sortLibraryPhotos(photos, 'date', 'desc').map(p => p.id), ['local_new', 'local_old', 'local_missing']);
  assert.deepEqual(sortLibraryPhotos(photos, 'date', 'asc').map(p => p.id), ['local_old', 'local_new', 'local_missing']);
});

test('bulk selection includes both sources and rejects excluded, missing and foreign photos', () => {
  const photos = [
    { id: 'vk_1', source: 'vk', community: 'current', available: true },
    { id: 'local_1', source: 'local', available: true },
    { id: 'excluded', source: 'local', available: true },
    { id: 'missing', source: 'local', available: false },
    { id: 'foreign', source: 'vk', community: 'another', available: true },
    { id: 'unselected', source: 'local', available: true },
  ];
  assert.deepEqual(selectedLibraryPhotos(['vk_1', 'local_1', 'excluded', 'missing', 'foreign', 'obsolete'], photos, ['excluded'], 'current').map(p => p.id), ['vk_1', 'local_1']);
  assert.deepEqual(selectedLibraryPhotos([], photos, [], 'current'), []);
});
