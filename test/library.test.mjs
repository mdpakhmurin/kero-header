import test from 'node:test';
import assert from 'node:assert/strict';
import { librarySource, sortLibraryPhotos, selectedLibraryPhotos, createFavoritesView } from '../public/library.js';

test('unstarred photos remain in the current favorites view across sorting and lazy loading', () => {
  const view = createFavoritesView(), favorites = new Set(['one', 'two', 'three']);
  assert.deepEqual([...view.ids(favorites, 'vk')], ['one', 'two', 'three']);
  favorites.delete('two');
  assert.equal(favorites.has('two'), false);
  assert.deepEqual([...view.ids(favorites, 'vk')], ['one', 'two', 'three']);
  assert.deepEqual([...view.ids(favorites, 'vk')], ['one', 'two', 'three']);
  favorites.add('four'); assert.equal(view.ids(favorites, 'vk').has('four'), true);
  view.ids(favorites, null);
  assert.deepEqual([...view.ids(favorites, 'vk')], ['one', 'three', 'four']);
});

test('leaving the source or closing the library clears temporarily retained favorites', () => {
  const view = createFavoritesView(); view.ids(['vk_photo'], 'vk');
  assert.equal(view.ids([], 'vk').has('vk_photo'), true);
  assert.deepEqual([...view.ids(['local_photo'], 'local')], ['local_photo']);
  assert.equal(view.ids([], 'vk').has('vk_photo'), false);
  view.ids(['vk_photo'], 'vk'); view.reset();
  assert.equal(view.ids([], 'vk').has('vk_photo'), false);
});

test('library sorts aspect ratios independently of pixel area and leaves unknown dimensions last', () => {
  const photos = [{ id: 'unknown' }, { id: 'wide', width: 1000, height: 20 }, { id: 'square', width: 2000, height: 2000 }, { id: 'portrait', width: 100, height: 300 }];
  assert.deepEqual(sortLibraryPhotos(photos, 'ratio', 'desc').map(p => p.id), ['wide', 'square', 'portrait', 'unknown']);
  assert.deepEqual(sortLibraryPhotos(photos, 'ratio', 'asc').map(p => p.id), ['portrait', 'square', 'wide', 'unknown']);
  assert.equal(photos[0].id, 'unknown');
  assert.deepEqual(sortLibraryPhotos([{ id: 'bad', width: 100, height: 0 }, { id: 'valid', width: 50, height: 50 }], 'ratio', 'asc').map(p => p.id), ['valid', 'bad']);
  assert.deepEqual(sortLibraryPhotos([{ id: 'b', width: 200, height: 100 }, { id: 'a', width: 20, height: 10 }], 'ratio').map(p => p.id), ['a', 'b']);
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
